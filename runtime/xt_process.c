#include "xt_runtime.h"
#include "xt_threadpool.h"
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <io.h>
#include <fcntl.h>
#else
#include <signal.h>
#include <fcntl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#endif


#ifdef _WIN32
static size_t _xt_win_utf16_len(const char* text) {
    int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, -1, NULL, 0);
    return length > 0 ? (size_t)length : 0;
}

static HANDLE _xt_process_null_handle(SECURITY_ATTRIBUTES* sa) {
    return CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                       sa, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
}

static int _xt_process_spawn_windows(const char* command, FILE** out_input, HANDLE* out_process,
                                     char* error, size_t error_size) {
    SECURITY_ATTRIBUTES sa;
    sa.nLength = sizeof(sa);
    sa.lpSecurityDescriptor = NULL;
    sa.bInheritHandle = TRUE;
    HANDLE hRead = NULL, hWrite = NULL;
    if (!CreatePipe(&hRead, &hWrite, &sa, 0)) {
        snprintf(error, error_size, "创建子进程标准输入管道失败, GetLastError=%lu", GetLastError());
        return 0;
    }
    if (!SetHandleInformation(hWrite, HANDLE_FLAG_INHERIT, 0)) {
        snprintf(error, error_size, "设置子进程管道继承属性失败, GetLastError=%lu", GetLastError());
        CloseHandle(hRead); CloseHandle(hWrite);
        return 0;
    }

    HANDLE hOut = GetStdHandle(STD_OUTPUT_HANDLE);
    HANDLE hErr = GetStdHandle(STD_ERROR_HANDLE);
    HANDLE hOutNull = NULL, hErrNull = NULL;
    if (!hOut || hOut == INVALID_HANDLE_VALUE) {
        hOutNull = _xt_process_null_handle(&sa);
        hOut = hOutNull;
    }
    if (!hErr || hErr == INVALID_HANDLE_VALUE) {
        hErrNull = _xt_process_null_handle(&sa);
        hErr = hErrNull;
    }
    if (!hOut || hOut == INVALID_HANDLE_VALUE || !hErr || hErr == INVALID_HANDLE_VALUE) {
        snprintf(error, error_size, "准备子进程标准输出句柄失败, GetLastError=%lu", GetLastError());
        CloseHandle(hRead); CloseHandle(hWrite);
        if (hOutNull) CloseHandle(hOutNull);
        if (hErrNull) CloseHandle(hErrNull);
        return 0;
    }

    size_t wcmd_capacity = _xt_win_utf16_len(command);
    if (wcmd_capacity == 0) {
        snprintf(error, error_size, "子进程命令的 UTF-8 转换失败, GetLastError=%lu", GetLastError());
        CloseHandle(hRead); CloseHandle(hWrite);
        if (hOutNull) CloseHandle(hOutNull);
        if (hErrNull) CloseHandle(hErrNull);
        return 0;
    }
    wchar_t* wcmd = (wchar_t*)malloc(wcmd_capacity * sizeof(wchar_t));
    if (!wcmd) {
        snprintf(error, error_size, "分配子进程命令失败");
        CloseHandle(hRead); CloseHandle(hWrite);
        if (hOutNull) CloseHandle(hOutNull);
        if (hErrNull) CloseHandle(hErrNull);
        return 0;
    }
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, command, -1, wcmd, (int)wcmd_capacity);
    const wchar_t prefix[] = L"cmd.exe /d /s /c \"";
    size_t line_capacity = wcmd_capacity + (sizeof(prefix) / sizeof(prefix[0])) + 2;
    wchar_t* cmdline = (wchar_t*)malloc(line_capacity * sizeof(wchar_t));
    if (!cmdline) {
        snprintf(error, error_size, "分配子进程命令行失败");
        free(wcmd);
        CloseHandle(hRead); CloseHandle(hWrite);
        if (hOutNull) CloseHandle(hOutNull);
        if (hErrNull) CloseHandle(hErrNull);
        return 0;
    }
    wcscpy(cmdline, prefix);
    wcscat(cmdline, wcmd);
    wcscat(cmdline, L"\"");
    free(wcmd);

    STARTUPINFOW si;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    si.hStdInput = hRead;
    si.hStdOutput = hOut;
    si.hStdError = hErr;
    PROCESS_INFORMATION pi;
    ZeroMemory(&pi, sizeof(pi));
    BOOL created = CreateProcessW(NULL, cmdline, NULL, NULL, TRUE, CREATE_NO_WINDOW,
                                  NULL, NULL, &si, &pi);
    free(cmdline);
    CloseHandle(hRead);
    if (hOutNull) CloseHandle(hOutNull);
    if (hErrNull) CloseHandle(hErrNull);
    if (!created) {
        snprintf(error, error_size, "启动子进程失败, GetLastError=%lu", GetLastError());
        CloseHandle(hWrite);
        return 0;
    }
    CloseHandle(pi.hThread);

    int fd = _open_osfhandle((intptr_t)hWrite, _O_WRONLY | _O_BINARY);
    if (fd < 0) {
        snprintf(error, error_size, "接管子进程标准输入管道失败");
        CloseHandle(hWrite);
        TerminateProcess(pi.hProcess, 1);
        WaitForSingleObject(pi.hProcess, 5000);
        CloseHandle(pi.hProcess);
        return 0;
    }
    FILE* input = _fdopen(fd, "wb");
    if (!input) {
        snprintf(error, error_size, "打开子进程标准输入流失败");
        _close(fd);
        TerminateProcess(pi.hProcess, 1);
        WaitForSingleObject(pi.hProcess, 5000);
        CloseHandle(pi.hProcess);
        return 0;
    }
    *out_input = input;
    *out_process = pi.hProcess;
    return 1;
}
#else
typedef struct {
    sigset_t set;
    sigset_t old_mask;
    int active;
} XTProcessSigGuard;

static int _xt_process_sig_begin(XTProcessSigGuard* guard) {
    sigemptyset(&guard->set);
    sigaddset(&guard->set, SIGPIPE);
    int rc = pthread_sigmask(SIG_BLOCK, &guard->set, &guard->old_mask);
    guard->active = rc == 0;
    if (rc != 0) errno = rc;
    return guard->active;
}

static void _xt_process_sig_end(XTProcessSigGuard* guard, int broken_pipe) {
    int saved_errno = errno;
    if (guard->active && broken_pipe) {
        sigset_t pending;
        if (sigpending(&pending) == 0 && sigismember(&pending, SIGPIPE)) {
            int signal_number = 0;
            (void)sigwait(&guard->set, &signal_number);
        }
    }
    if (guard->active) pthread_sigmask(SIG_SETMASK, &guard->old_mask, NULL);
    errno = saved_errno;
}

static int _xt_process_spawn_posix(const char* command, FILE** out_input, intptr_t* out_pid,
                                   char* error, size_t error_size) {
    int fds[2];
    if (pipe(fds) != 0) {
        snprintf(error, error_size, "创建子进程标准输入管道失败: %s", strerror(errno));
        return 0;
    }
    if (fcntl(fds[0], F_SETFD, FD_CLOEXEC) != 0 || fcntl(fds[1], F_SETFD, FD_CLOEXEC) != 0) {
        snprintf(error, error_size, "设置子进程管道关闭标志失败: %s", strerror(errno));
        close(fds[0]); close(fds[1]);
        return 0;
    }
    pid_t pid = fork();
    if (pid < 0) {
        snprintf(error, error_size, "创建子进程失败: %s", strerror(errno));
        close(fds[0]); close(fds[1]);
        return 0;
    }
    if (pid == 0) {
        close(fds[1]);
        if (dup2(fds[0], STDIN_FILENO) < 0) _exit(126);
        close(fds[0]);
        execl("/bin/sh", "sh", "-c", command, (char*)NULL);
        _exit(127);
    }
    close(fds[0]);
    FILE* input = fdopen(fds[1], "w");
    if (!input) {
        snprintf(error, error_size, "打开子进程标准输入流失败: %s", strerror(errno));
        close(fds[1]);
        kill(pid, SIGKILL);
        while (waitpid(pid, NULL, 0) < 0 && errno == EINTR) { }
        return 0;
    }
    *out_input = input;
    *out_pid = (intptr_t)pid;
    return 1;
}
#endif

static XTProcess* _xt_process_of(XTValue value) {
    if (!XT_IS_REAL_PTR(value)) return NULL;
    if (((XTObject*)value)->type_id != XT_TYPE_PROCESS) return NULL;
    return (XTProcess*)value;
}

static XTValue _xt_process_failure(XTProcess* process, const char* fallback) {
    const char* message = fallback;
    int code = -1;
    if (process) {
        if (process->error[0]) message = process->error;
        if (process->waited) code = process->exit_code;
    }
    return (XTValue)xt_result_new(0, (void*)XT_FROM_INT(code), (void*)xt_string_new(message));
}

static XTValue _xt_process_success_int(int code) {
    return (XTValue)xt_result_new(1, (void*)XT_FROM_INT(code), NULL);
}

XTValue xt_process_start(XTValue cmd_val) {
    if (!XT_IS_REAL_PTR(cmd_val) || ((XTObject*)cmd_val)->type_id != XT_TYPE_STRING) {
        return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("子进程命令必须是字符串"));
    }
    XTString* cmd = (XTString*)cmd_val;
    if (cmd->length == 0) {
        return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("子进程命令不能为空"));
    }
    FILE* input = NULL;
    char error[256] = {0};
#ifdef _WIN32
    HANDLE process = NULL;
    int ok = _xt_process_spawn_windows(cmd->data, &input, &process, error, sizeof(error));
#else
    intptr_t process = 0;
    int ok = _xt_process_spawn_posix(cmd->data, &input, &process, error, sizeof(error));
#endif
    if (!ok) {
        return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new(error));
    }
    XTProcess* handle = (XTProcess*)xt_malloc(sizeof(XTProcess), XT_TYPE_PROCESS);
    memset((char*)handle + sizeof(XTObject), 0, sizeof(XTProcess) - sizeof(XTObject));
    handle->input = input;
#ifdef _WIN32
    handle->process = process;
#else
    handle->process_id = process;
#endif
    handle->exit_code = -1;
    return (XTValue)xt_result_new(1, (void*)handle, NULL);
}

XTValue xt_process_write(XTValue process_val, XTValue content_val) {
    XTProcess* process = _xt_process_of(process_val);
    if (!process) return _xt_process_failure(NULL, "不是子进程句柄");
    if (process->input_closed || !process->input) {
        snprintf(process->error, sizeof(process->error), "子进程标准输入已关闭");
        return _xt_process_failure(process, process->error);
    }
    if (!XT_IS_REAL_PTR(content_val)) return _xt_process_failure(process, "写入内容必须是字符串或字节");
    const char* data = NULL;
    size_t length = 0;
    if (((XTObject*)content_val)->type_id == XT_TYPE_STRING) {
        XTString* text = (XTString*)content_val;
        data = text->data;
        length = text->length;
    } else if (((XTObject*)content_val)->type_id == XT_TYPE_BYTES) {
        XTBytes* bytes = (XTBytes*)content_val;
        data = (const char*)bytes->data;
        length = bytes->length;
    } else {
        return _xt_process_failure(process, "写入内容必须是字符串或字节");
    }
#ifndef _WIN32
    XTProcessSigGuard guard;
    if (!_xt_process_sig_begin(&guard)) {
        snprintf(process->error, sizeof(process->error), "无法保护子进程写入: %s", strerror(errno));
        return _xt_process_failure(process, process->error);
    }
#endif
    size_t offset = 0;
    int failed = 0;
    while (offset < length) {
        size_t written = fwrite(data + offset, 1, length - offset, process->input);
        offset += written;
        if (written == 0) { failed = 1; break; }
    }
    if (failed || ferror(process->input)) {
        int saved_errno = errno == 0 ? EIO : errno;
        snprintf(process->error, sizeof(process->error), "写入子进程标准输入失败: %s", strerror(saved_errno));
        errno = saved_errno;
#ifndef _WIN32
        _xt_process_sig_end(&guard, saved_errno == EPIPE);
#endif
        return _xt_process_failure(process, process->error);
    }
#ifndef _WIN32
    _xt_process_sig_end(&guard, 0);
#endif
    return (XTValue)xt_result_new(1, (void*)XT_TRUE, NULL);
}

XTValue xt_process_flush(XTValue process_val) {
    XTProcess* process = _xt_process_of(process_val);
    if (!process) return _xt_process_failure(NULL, "不是子进程句柄");
    if (process->input_closed || !process->input) {
        snprintf(process->error, sizeof(process->error), "子进程标准输入已关闭");
        return _xt_process_failure(process, process->error);
    }
#ifndef _WIN32
    XTProcessSigGuard guard;
    if (!_xt_process_sig_begin(&guard)) {
        snprintf(process->error, sizeof(process->error), "无法保护子进程刷新: %s", strerror(errno));
        return _xt_process_failure(process, process->error);
    }
#endif
    int rc = fflush(process->input);
    int saved_errno = errno;
#ifndef _WIN32
    _xt_process_sig_end(&guard, rc != 0 && saved_errno == EPIPE);
#endif
    if (rc != 0) {
        if (saved_errno == 0) saved_errno = EIO;
        snprintf(process->error, sizeof(process->error), "刷新子进程标准输入失败: %s", strerror(saved_errno));
        return _xt_process_failure(process, process->error);
    }
    return (XTValue)xt_result_new(1, (void*)XT_TRUE, NULL);
}

static int _xt_process_close_input_impl(XTProcess* process) {
    if (process->input_closed) return process->input_error ? -1 : 0;
    process->input_closed = 1;
    FILE* input = process->input;
    process->input = NULL;
#ifndef _WIN32
    XTProcessSigGuard guard;
    if (!_xt_process_sig_begin(&guard)) {
        process->input_error = 1;
        snprintf(process->error, sizeof(process->error), "无法保护子进程关闭: %s", strerror(errno));
        return -1;
    }
#endif
    int rc = input ? fclose(input) : 0;
    int saved_errno = errno;
#ifndef _WIN32
    _xt_process_sig_end(&guard, rc != 0 && saved_errno == EPIPE);
#endif
    if (rc != 0) {
        process->input_error = 1;
        if (saved_errno == 0) saved_errno = EIO;
        snprintf(process->error, sizeof(process->error), "关闭子进程标准输入失败: %s", strerror(saved_errno));
        return -1;
    }
    return 0;
}

XTValue xt_process_close_input(XTValue process_val) {
    XTProcess* process = _xt_process_of(process_val);
    if (!process) return _xt_process_failure(NULL, "不是子进程句柄");
    if (_xt_process_close_input_impl(process) != 0) return _xt_process_failure(process, process->error);
    return (XTValue)xt_result_new(1, (void*)XT_TRUE, NULL);
}

XTValue xt_process_wait(XTValue process_val) {
    XTProcess* process = _xt_process_of(process_val);
    if (!process) return _xt_process_failure(NULL, "不是子进程句柄");
    if (process->waited) {
        if (process->wait_error) return _xt_process_failure(process, process->error);
        return _xt_process_success_int(process->exit_code);
    }
    int close_failed = _xt_process_close_input_impl(process) != 0;
#ifdef _WIN32
    DWORD wait_result = WaitForSingleObject(process->process, INFINITE);
    if (wait_result != WAIT_OBJECT_0) {
        process->wait_error = 1;
        snprintf(process->error, sizeof(process->error), "等待子进程退出失败, GetLastError=%lu", GetLastError());
    } else {
        DWORD code = 0;
        if (!GetExitCodeProcess(process->process, &code)) {
            process->wait_error = 1;
            snprintf(process->error, sizeof(process->error), "读取子进程退出码失败, GetLastError=%lu", GetLastError());
        } else {
            process->exit_code = (int)code;
        }
    }
    CloseHandle(process->process);
    process->process = NULL;
#else
    int status = 0;
    pid_t pid = (pid_t)process->process_id;
    pid_t waited;
    do { waited = waitpid(pid, &status, 0); } while (waited < 0 && errno == EINTR);
    if (waited < 0) {
        process->wait_error = 1;
        snprintf(process->error, sizeof(process->error), "等待子进程退出失败: %s", strerror(errno));
    } else if (WIFEXITED(status)) {
        process->exit_code = WEXITSTATUS(status);
    } else if (WIFSIGNALED(status)) {
        process->exit_code = 128 + WTERMSIG(status);
    } else {
        process->wait_error = 1;
        snprintf(process->error, sizeof(process->error), "子进程未正常结束");
    }
    process->process_id = 0;
#endif
    process->waited = 1;
    if (!process->wait_error && close_failed) process->wait_error = 1;
    if (process->wait_error) return _xt_process_failure(process, process->error);
    return _xt_process_success_int(process->exit_code);
}
