; XuanTie v0.11.2 LLVM Backend
target datalayout = "e-m:w-p270:32:32-p271:32:32-p272:64:64-i64:64-f80:128-n8:16:32:64-S128"
target triple = "x86_64-pc-windows-msvc"

@str.0 = private unnamed_addr constant [7 x i8] c"我叫\00"
@str.1 = private unnamed_addr constant [10 x i8] c"，今年\00"
@str.2 = private unnamed_addr constant [4 x i8] c"岁\00"
@str.3 = private unnamed_addr constant [4 x i8] c"人\00"
@str.4 = private unnamed_addr constant [7 x i8] c"小明\00"

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

@"小明" = global %XTInstance* null

define i64 @"人_造"(i8* %"this_arg", i8* %"名_arg", i8* %"岁_arg") {
entry:
  %"此" = alloca i8*
  store i8* %"this_arg", i8** %"此"
  %"名" = alloca i8*
  store i8* %"名_arg", i8** %"名"
  %"岁" = alloca i8*
  store i8* %"岁_arg", i8** %"岁"
  %t1 = load i8*, i8** %"名"
  %t2 = load i8*, i8** %"此"
  %t3 = bitcast i8* %t2 to %XTInstance*
  %t4 = getelementptr %XTInstance, %XTInstance* %t3, i32 0, i32 3
  %t5 = load i8**, i8*** %t4
  %t6 = getelementptr i8*, i8** %t5, i64 0
  %t7 = bitcast i8* %t1 to i8*
  store i8* %t7, i8** %t6
  %t8 = load i8*, i8** %"岁"
  %t9 = load i8*, i8** %"此"
  %t10 = bitcast i8* %t9 to %XTInstance*
  %t11 = getelementptr %XTInstance, %XTInstance* %t10, i32 0, i32 3
  %t12 = load i8**, i8*** %t11
  %t13 = getelementptr i8*, i8** %t12, i64 1
  %t14 = bitcast i8* %t8 to i8*
  store i8* %t14, i8** %t13
  ret i64 0
}
define i64 @"人_介绍"(i8* %"this_arg") {
entry:
  %"此" = alloca i8*
  store i8* %"this_arg", i8** %"此"
  %t15 = getelementptr inbounds [7 x i8], [7 x i8]* @str.0, i64 0, i64 0
  %t16 = call %XTString* @xt_string_new(i8* %t15)
  %t17 = bitcast %XTString* %t16 to i8*
  %t18 = call %XTString* @xt_obj_to_string(i8* %t17)
  %t19 = load i8*, i8** %"此"
  %t20 = bitcast i8* %t19 to %XTInstance*
  %t21 = getelementptr %XTInstance, %XTInstance* %t20, i32 0, i32 3
  %t22 = load i8**, i8*** %t21
  %t23 = getelementptr i8*, i8** %t22, i64 0
  %t24 = load i8*, i8** %t23
  %t25 = call %XTString* @xt_obj_to_string(i8* %t24)
  %t26 = call %XTString* @xt_string_concat(%XTString* %t18, %XTString* %t25)
  %t27 = bitcast %XTString* %t26 to i8*
  %t28 = call %XTString* @xt_obj_to_string(i8* %t27)
  %t29 = getelementptr inbounds [10 x i8], [10 x i8]* @str.1, i64 0, i64 0
  %t30 = call %XTString* @xt_string_new(i8* %t29)
  %t31 = bitcast %XTString* %t30 to i8*
  %t32 = call %XTString* @xt_obj_to_string(i8* %t31)
  %t33 = call %XTString* @xt_string_concat(%XTString* %t28, %XTString* %t32)
  %t34 = bitcast %XTString* %t33 to i8*
  %t35 = call %XTString* @xt_obj_to_string(i8* %t34)
  %t36 = load i8*, i8** %"此"
  %t37 = bitcast i8* %t36 to %XTInstance*
  %t38 = getelementptr %XTInstance, %XTInstance* %t37, i32 0, i32 3
  %t39 = load i8**, i8*** %t38
  %t40 = getelementptr i8*, i8** %t39, i64 1
  %t41 = load i8*, i8** %t40
  %t42 = call %XTString* @xt_obj_to_string(i8* %t41)
  %t43 = call %XTString* @xt_string_concat(%XTString* %t35, %XTString* %t42)
  %t44 = bitcast %XTString* %t43 to i8*
  %t45 = call %XTString* @xt_obj_to_string(i8* %t44)
  %t46 = getelementptr inbounds [4 x i8], [4 x i8]* @str.2, i64 0, i64 0
  %t47 = call %XTString* @xt_string_new(i8* %t46)
  %t48 = bitcast %XTString* %t47 to i8*
  %t49 = call %XTString* @xt_obj_to_string(i8* %t48)
  %t50 = call %XTString* @xt_string_concat(%XTString* %t45, %XTString* %t49)
  call void @xt_print_string(%XTString* %t50)
  ret i64 0
}

define i32 @main() {
entry:
  call void @xt_init()
  %t52 = getelementptr inbounds [4 x i8], [4 x i8]* @str.3, i64 0, i64 0
  %t51 = call %XTInstance* @xt_instance_new(i8* %t52, i64 2)
  %t53 = bitcast %XTInstance* %t51 to i8*
  %t54 = getelementptr inbounds [7 x i8], [7 x i8]* @str.4, i64 0, i64 0
  %t55 = call %XTString* @xt_string_new(i8* %t54)
  %t56 = bitcast %XTString* %t55 to i8*
  %t57 = call i8* @xt_int_new(i64 18)
  call i64 @"人_造"(i8* %t53, i8* %t56, i8* %t57)
  store %XTInstance* %t51, %XTInstance** @"小明"
  %t58 = load %XTInstance*, %XTInstance** @"小明"
  %t59 = bitcast %XTInstance* %t58 to i8*
  %t60 = call i64 @"人_介绍"(i8* %t59)
  ret i32 0
}
