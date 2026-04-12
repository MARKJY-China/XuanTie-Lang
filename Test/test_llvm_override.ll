; XuanTie v0.13.2 LLVM Backend
target datalayout = "e-m:w-p270:32:32-p271:32:32-p272:64:64-i64:64-f80:128-n8:16:32:64-S128"
target triple = "x86_64-pc-windows-msvc"

@str.0 = private unnamed_addr constant [13 x i8] c"动物在叫\00"
@str.1 = private unnamed_addr constant [7 x i8] c"汪汪\00"
@str.2 = private unnamed_addr constant [4 x i8] c"狗\00"
@str.3 = private unnamed_addr constant [7 x i8] c"动物\00"

%XTString = type { i32, i32, i8*, i64 }
%XTArray = type { i32, i32, i8**, i64, i64 }
%XTInstance = type { i32, i32, i8*, i8** }
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
declare %XTString* @xt_string_concat(%XTString*, %XTString*)
declare %XTString* @xt_int_to_string(i64)
declare %XTString* @xt_obj_to_string(i8*)
declare void @xt_retain(i8*)
declare void @xt_release(i8*)
declare i64 @xt_to_int(i8*)

@"d" = global %XTInstance* null
@"a" = global %XTInstance* null

define i64 @"动物_叫"(i8* %"this_arg") {
entry:
  %"此" = alloca i8*
  store i8* %"this_arg", i8** %"此"
  %t1 = getelementptr inbounds [13 x i8], [13 x i8]* @str.0, i64 0, i64 0
  %t2 = call %XTString* @xt_string_new(i8* %t1)
  call void @xt_print_string(%XTString* %t2)
  ret i64 0
}
define i64 @"狗_叫"(i8* %"this_arg") {
entry:
  %"此" = alloca i8*
  store i8* %"this_arg", i8** %"此"
  %t3 = getelementptr inbounds [7 x i8], [7 x i8]* @str.1, i64 0, i64 0
  %t4 = call %XTString* @xt_string_new(i8* %t3)
  call void @xt_print_string(%XTString* %t4)
  ret i64 0
}

define i32 @main() {
entry:
  call void @xt_init()
  %t6 = getelementptr inbounds [4 x i8], [4 x i8]* @str.2, i64 0, i64 0
  %t5 = call %XTInstance* @xt_instance_new(i8* %t6, i64 0)
  store %XTInstance* %t5, %XTInstance** @"d"
  %t7 = load %XTInstance*, %XTInstance** @"d"
  %t8 = bitcast %XTInstance* %t7 to i8*
  %t9 = call i64 @"狗_叫"(i8* %t8)
  %t11 = getelementptr inbounds [7 x i8], [7 x i8]* @str.3, i64 0, i64 0
  %t10 = call %XTInstance* @xt_instance_new(i8* %t11, i64 0)
  store %XTInstance* %t10, %XTInstance** @"a"
  %t12 = load %XTInstance*, %XTInstance** @"a"
  %t13 = bitcast %XTInstance* %t12 to i8*
  %t14 = call i64 @"动物_叫"(i8* %t13)
  ret i32 0
}
