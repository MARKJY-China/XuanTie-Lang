; XuanTie v0.11.2 LLVM Backend
target datalayout = "e-m:w-p270:32:32-p271:32:32-p272:64:64-i64:64-f80:128-n8:16:32:64-S128"
target triple = "x86_64-pc-windows-msvc"

@str.0 = private unnamed_addr constant [16 x i8] c"Hello from LLVM\00"

%XTString = type { i32, i32, i8*, i64 }
%XTArray = type { i32, i32, i8**, i64, i64 }
%XTInstance = type { i32, i32, i8*, i8** }
declare void @xt_init()
declare void @xt_print_int(i64)
declare void @xt_print_string(%XTString*)
declare void @xt_print_bool(i1)
declare void @xt_print_float(double)
declare i8* @xt_int_new(i64)
declare %XTString* @xt_string_new(i8*)
declare %XTArray* @xt_array_new(i64)
declare void @xt_array_append(%XTArray*, i8*)
declare %XTInstance* @xt_instance_new(i8*, i64)
declare %XTString* @xt_string_concat(%XTString*, %XTString*)
declare %XTString* @xt_int_to_string(i64)
declare void @xt_retain(i8*)
declare void @xt_release(i8*)
declare i64 @xt_to_int(i8*)

@"a" = global i64 0
@"b" = global i64 0


define i32 @main() {
entry:
  call void @xt_init()
  store i64 10, i64* @"a"
  store i64 20, i64* @"b"
  %t1 = load i64, i64* @"a"
  %t2 = load i64, i64* @"b"
  %t3 = add i64 %t1, %t2
  call void @xt_print_int(i64 %t3)
  %t4 = getelementptr inbounds [16 x i8], [16 x i8]* @str.0, i64 0, i64 0
  %t5 = call %XTString* @xt_string_new(i8* %t4)
  call void @xt_print_string(%XTString* %t5)
  ret i32 0
}
