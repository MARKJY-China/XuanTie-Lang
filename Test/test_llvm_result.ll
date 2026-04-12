; XuanTie v0.13.2 LLVM Backend
target datalayout = "e-m:w-p270:32:32-p271:32:32-p272:64:64-i64:64-f80:128-n8:16:32:64-S128"
target triple = "x86_64-pc-windows-msvc"

@str.0 = private unnamed_addr constant [13 x i8] c"错误信息\00"

%XTString = type { i32, i32, i8*, i64 }
%XTArray = type { i32, i32, i8**, i64, i64 }
%XTInstance = type { i32, i32, i8*, i8** }
%XTResult = type { i32, i32, i1, i8*, i8* }
declare void @xt_init()
declare void @xt_print_int(i64)
declare void @xt_print_string(%XTString*)
declare void @xt_print_bool(i1)
declare void @xt_print_float(double)
declare i8* @xt_int_new(i64)
declare i8* @xt_float_new(double)
declare i8* @xt_bool_new(i1)
declare %XTString* @xt_string_new(i8*)
declare %XTArray* @xt_array_new(i64)
declare void @xt_array_append(%XTArray*, i8*)
declare %XTInstance* @xt_instance_new(i8*, i64)
declare i8* @xt_result_new(i1, i8*, i8*)
declare %XTString* @xt_string_concat(%XTString*, %XTString*)
declare %XTString* @xt_int_to_string(i64)
declare %XTString* @xt_obj_to_string(i8*)
declare void @xt_retain(i8*)
declare void @xt_release(i8*)
declare i64 @xt_to_int(i8*)

@"r1" = global i8* null
@"r2" = global i8* null


define i32 @main() {
entry:
  call void @xt_init()
  %t1 = call i8* @xt_int_new(i64 100)
  %t2 = call i8* @xt_result_new(i1 1, i8* %t1, i8* null)
  store i8* %t2, i8** @"r1"
  %t3 = load i8*, i8** @"r1"
  %t4 = call %XTString* @xt_obj_to_string(i8* %t3)
  call void @xt_print_string(%XTString* %t4)
  %t5 = getelementptr inbounds [13 x i8], [13 x i8]* @str.0, i64 0, i64 0
  %t6 = call %XTString* @xt_string_new(i8* %t5)
  %t7 = bitcast %XTString* %t6 to i8*
  %t8 = call i8* @xt_result_new(i1 0, i8* null, i8* %t7)
  store i8* %t8, i8** @"r2"
  %t9 = load i8*, i8** @"r2"
  %t10 = call %XTString* @xt_obj_to_string(i8* %t9)
  call void @xt_print_string(%XTString* %t10)
  ret i32 0
}
