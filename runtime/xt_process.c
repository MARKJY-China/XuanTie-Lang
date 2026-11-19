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
#include <poll.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
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

/* ============================================================
 * 执(命令[, 超时毫秒]) 的底层捕获实现
 *
 * 设计目标（issue #162）：
 *   - Windows 不再写临时 .bat：直接 CreateProcessW(cmd.exe /d /s /c)，
 *     命令 UTF-8 → UTF-16，彻底消除非 ASCII TEMP 路径、临时文件竞争与
 *     AutoRun/AV 误报；
 *   - 输出用倍增缓冲（O(n)），上限 64 MiB；
 *   - 可选超时：Windows 用 JobObject 杀整棵进程树，POSIX 用进程组；
 *   - 退出码统一归一化，绝不把 -1 当成功。
 * ============================================================ */
#define XT_EXEC_OUTPUT_LIMIT ((size_t)64 * 1024 * 1024)

static int _xt_exec_append(char** buf, size_t* len, size_t* cap,
                           const char* data, size_t n) {
    if (n > XT_EXEC_OUTPUT_LIMIT - *len) return 0;
    if (*len + n + 1 > *cap) {
        size_t next = *cap ? *cap : 4096;
        while (next < *len + n + 1) {
            if (next > XT_EXEC_OUTPUT_LIMIT / 2) { next = XT_EXEC_OUTPUT_LIMIT + 1; break; }
            next *= 2;
        }
        if (next > XT_EXEC_OUTPUT_LIMIT + 1) next = XT_EXEC_OUTPUT_LIMIT + 1;
        char* p = (char*)realloc(*buf, next);
        if (!p) return 0;
        *buf = p;
        *cap = next;
    }
    if (n > 0) memcpy(*buf + *len, data, n);
    *len += n;
    (*buf)[*len] = '\0';
    return 1;
}

static void _xt_exec_empty(char** out_data, size_t* out_len) {
    *out_data = (char*)malloc(1);
    if (*out_data) (*out_data)[0] = '\0';
    *out_len = 0;
}

#ifdef _WIN32
static HANDLE _xt_exec_open_nul_read(SECURITY_ATTRIBUTES* sa) {
    return CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                       sa, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
}

static void _xt_exec_drain_pipe(HANDLE hRead, char** out, size_t* len, size_t* cap,
                                int* overflow) {
    char buf[8192];
    for (;;) {
        DWORD avail = 0;
        if (!PeekNamedPipe(hRead, NULL, 0, NULL, &avail, NULL) || avail == 0) return;
        DWORD want = avail > (DWORD)sizeof(buf) ? (DWORD)sizeof(buf) : avail;
        DWORD got = 0;
        if (!ReadFile(hRead, buf, want, &got, NULL) || got == 0) return;
        if (!_xt_exec_append(out, len, cap, buf, (size_t)got)) {
            *overflow = 1;
            return;
        }
    }
}

int xt_process_exec_capture(const char* command, int64_t timeout_ms,
                            char** out_data, size_t* out_len, int* exit_code,
                            int* timed_out, char* error, size_t error_size) {
    SECURITY_ATTRIBUTES sa;
    HANDLE hRead = NULL, hWrite = NULL, hNul = INVALID_HANDLE_VALUE;
    HANDLE job = NULL;
    PROCESS_INFORMATION pi;
    STARTUPINFOW si;
    wchar_t* wcmd = NULL;
    wchar_t* line = NULL;
    char* out = NULL;
    size_t len = 0, cap = 0;
    int overflow = 0;
    DWORD code = 1;
    int result = 0;

    *out_data = NULL;
    *out_len = 0;
    *exit_code = 0;
    *timed_out = 0;
    if (error && error_size) error[0] = '\0';
    if (!command) {
        if (error && error_size) snprintf(error, error_size, "命令为空");
        return 0;
    }
    if (timeout_ms < 0) timeout_ms = 0;
    if (timeout_ms > 24LL * 60 * 60 * 1000) timeout_ms = 24LL * 60 * 60 * 1000;

    sa.nLength = sizeof(sa);
    sa.lpSecurityDescriptor = NULL;
    sa.bInheritHandle = TRUE;
    if (!CreatePipe(&hRead, &hWrite, &sa, 0)) {
        if (error && error_size) snprintf(error, error_size, "创建执输出管道失败, GetLastError=%lu", GetLastError());
        return 0;
    }
    SetHandleInformation(hRead, HANDLE_FLAG_INHERIT, 0);
    hNul = _xt_exec_open_nul_read(&sa);
    if (hNul == INVALID_HANDLE_VALUE) {
        if (error && error_size) snprintf(error, error_size, "打开 NUL 失败, GetLastError=%lu", GetLastError());
        CloseHandle(hRead); CloseHandle(hWrite);
        return 0;
    }

    size_t wlen = _xt_win_utf16_len(command);
    if (wlen == 0) {
        if (error && error_size) snprintf(error, error_size, "命令的 UTF-8 转 UTF-16 失败");
        CloseHandle(hRead); CloseHandle(hWrite); CloseHandle(hNul);
        return 0;
    }
    wcmd = (wchar_t*)malloc(wlen * sizeof(wchar_t));
    if (!wcmd) {
        if (error && error_size) snprintf(error, error_size, "分配命令缓冲失败");
        CloseHandle(hRead); CloseHandle(hWrite); CloseHandle(hNul);
        return 0;
    }
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, command, -1, wcmd, (int)wlen);

    size_t line_cap = wlen + 64;
    line = (wchar_t*)malloc(line_cap * sizeof(wchar_t));
    if (!line) {
        if (error && error_size) snprintf(error, error_size, "分配命令行缓冲失败");
        free(wcmd);
        CloseHandle(hRead); CloseHandle(hWrite); CloseHandle(hNul);
        return 0;
    }
    if (_snwprintf(line, line_cap, L"cmd.exe /d /s /c chcp 65001 >nul & %ls", wcmd) < 0) {
        if (error && error_size) snprintf(error, error_size, "命令行过长");
        free(wcmd); free(line);
        CloseHandle(hRead); CloseHandle(hWrite); CloseHandle(hNul);
        return 0;
    }
    free(wcmd);

    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    si.hStdInput = hNul;
    si.hStdOutput = hWrite;
    si.hStdError = hWrite;
    ZeroMemory(&pi, sizeof(pi));

    BOOL created = CreateProcessW(NULL, line, NULL, NULL, TRUE,
                                  CREATE_NO_WINDOW | CREATE_SUSPENDED,
                                  NULL, NULL, &si, &pi);
    free(line);
    CloseHandle(hWrite);
    CloseHandle(hNul);
    if (!created) {
        if (error && error_size) snprintf(error, error_size, "启动子进程失败, GetLastError=%lu", GetLastError());
        CloseHandle(hRead);
        return 0;
    }

    job = CreateJobObjectW(NULL, NULL);
    if (job) {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION info;
        ZeroMemory(&info, sizeof(info));
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info, sizeof(info)) ||
            !AssignProcessToJobObject(job, pi.hProcess)) {
            CloseHandle(job);
            job = NULL;
        }
    }
    ResumeThread(pi.hThread);
    CloseHandle(pi.hThread);

    uint64_t start = GetTickCount64();
    for (;;) {
        _xt_exec_drain_pipe(hRead, &out, &len, &cap, &overflow);
        if (overflow) break;

        DWORD wait_ms = 20;
        uint64_t elapsed = GetTickCount64() - start;
        if (timeout_ms > 0) {
            if (elapsed >= (uint64_t)timeout_ms) {
                *timed_out = 1;
                break;
            }
            uint64_t remain = (uint64_t)timeout_ms - elapsed;
            if (remain < wait_ms) wait_ms = (DWORD)remain;
        }
        DWORD w = WaitForSingleObject(pi.hProcess, wait_ms);
        if (w == WAIT_OBJECT_0) break;
        if (w == WAIT_FAILED) {
            if (error && error_size) snprintf(error, error_size, "等待子进程失败, GetLastError=%lu", GetLastError());
            overflow = 1;
            break;
        }
    }

    if (*timed_out || overflow) {
        if (job) TerminateJobObject(job, 1);
        else TerminateProcess(pi.hProcess, 1);
        WaitForSingleObject(pi.hProcess, 5000);
    }
    _xt_exec_drain_pipe(hRead, &out, &len, &cap, &overflow);
    if (!*timed_out) {
        DWORD got_code = 0;
        if (GetExitCodeProcess(pi.hProcess, &got_code)) code = got_code;
    } else {
        code = 124;
    }
    if (job) CloseHandle(job);
    CloseHandle(pi.hProcess);
    CloseHandle(hRead);

    if (overflow) {
        if (error && error_size) snprintf(error, error_size, "执 输出超过 64 MiB 上限");
        free(out);
        return 0;
    }
    if (!out) _xt_exec_empty(&out, &len);
    if (!out) {
        if (error && error_size) snprintf(error, error_size, "执 输出内存不足");
        return 0;
    }
    *out_data = out;
    *out_len = len;
    *exit_code = (int)code;
    result = 1;
    return result;
}
#else
static int64_t _xt_exec_now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

int xt_process_exec_capture(const char* command, int64_t timeout_ms,
                            char** out_data, size_t* out_len, int* exit_code,
                            int* timed_out, char* error, size_t error_size) {
    int fds[2];
    pid_t pid;
    char* out = NULL;
    size_t len = 0, cap = 0;
    int status = 0;
    int overflow = 0;
    int64_t start;
    char buf[8192];

    *out_data = NULL;
    *out_len = 0;
    *exit_code = 0;
    *timed_out = 0;
    if (error && error_size) error[0] = '\0';
    if (!command) {
        if (error && error_size) snprintf(error, error_size, "命令为空");
        return 0;
    }
    if (timeout_ms < 0) timeout_ms = 0;
    if (pipe(fds) != 0) {
        if (error && error_size) snprintf(error, error_size, "创建执输出管道失败: %s", strerror(errno));
        return 0;
    }
    pid = fork();
    if (pid < 0) {
        if (error && error_size) snprintf(error, error_size, "fork 失败: %s", strerror(errno));
        close(fds[0]); close(fds[1]);
        return 0;
    }
    if (pid == 0) {
        setpgid(0, 0);
        close(fds[0]);
        int devnull = open("/dev/null", O_RDONLY);
        if (devnull >= 0) { dup2(devnull, 0); close(devnull); }
        dup2(fds[1], 1);
        dup2(fds[1], 2);
        close(fds[1]);
        execl("/bin/sh", "sh", "-c", command, (char*)NULL);
        _exit(127);
    }
    close(fds[1]);
    setpgid(pid, pid);
    start = _xt_exec_now_ms();

    for (;;) {
        struct pollfd pfd;
        pfd.fd = fds[0];
        pfd.events = POLLIN | POLLHUP | POLLERR;
        pfd.revents = 0;
        int pr = poll(&pfd, 1, 20);
        if (pr > 0) {
            ssize_t n = read(fds[0], buf, sizeof(buf));
            if (n > 0) {
                if (!_xt_exec_append(&out, &len, &cap, buf, (size_t)n)) {
                    overflow = 1;
                    break;
                }
            } else if (n == 0) {
                /* 子进程关闭 stdout；继续等 waitpid，避免重复 POLLHUP 空转 */
            } else if (errno != EINTR && errno != EAGAIN) {
                break;
            }
        }

        pid_t w = waitpid(pid, &status, WNOHANG);
        if (w == pid) break;
        if (w < 0 && errno != EINTR) break;
        if (timeout_ms > 0 && _xt_exec_now_ms() - start >= timeout_ms) {
            *timed_out = 1;
            break;
        }
    }

    if (*timed_out || overflow) {
        kill(-pid, SIGKILL);
        kill(pid, SIGKILL);
        waitpid(pid, &status, 0);
    } else {
        /* 子进程退出后把管道里剩余输出读干净 */
        for (;;) {
            ssize_t n = read(fds[0], buf, sizeof(buf));
            if (n > 0) {
                if (!_xt_exec_append(&out, &len, &cap, buf, (size_t)n)) {
                    overflow = 1;
                    break;
                }
            } else {
                break;
            }
        }
        /* 某些平台 waitpid 在循环内未命中时再收一次 */
        int dummy = 0;
        pid_t w = waitpid(pid, &dummy, WNOHANG);
        if (w == pid) status = dummy;
    }
    close(fds[0]);

    if (overflow) {
        if (error && error_size) snprintf(error, error_size, "执 输出超过 64 MiB 上限");
        free(out);
        return 0;
    }
    if (!out) _xt_exec_empty(&out, &len);
    if (!out) {
        if (error && error_size) snprintf(error, error_size, "执 输出内存不足");
        return 0;
    }
    if (*timed_out) {
        *exit_code = 124;
    } else if (WIFEXITED(status)) {
        *exit_code = WEXITSTATUS(status);
    } else if (WIFSIGNALED(status)) {
        *exit_code = 128 + WTERMSIG(status);
    } else {
        *exit_code = 1;
    }
    *out_data = out;
    *out_len = len;
    return 1;
}
#endif
