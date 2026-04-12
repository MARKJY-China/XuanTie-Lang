; XuanTie v0.13.2 LLVM Backend
target datalayout = "e-m:w-p270:32:32-p271:32:32-p272:64:64-i64:64-f80:128-n8:16:32:64-S128"
target triple = "x86_64-pc-windows-msvc"

@str.0 = private unnamed_addr constant [7 x i8] c"盒子\00"

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

@"b1" = global %XTInstance* null
@"b2" = global %XTInstance* null
@"b3" = global i64 0

define i64 @"盒子_造"(i8* %"this_arg", i8* %"v_arg") {
entry:
  %"此" = alloca i8*
  store i8* %"this_arg", i8** %"此"
  %"v" = alloca i8*
  store i8* %"v_arg", i8** %"v"
  %t1 = load i8*, i8** %"v"
  %t2 = load i8*, i8** %"此"
  %t3 = bitcast i8* %t2 to %XTInstance*
  %t4 = getelementptr %XTInstance, %XTInstance* %t3, i32 0, i32 3
  %t5 = load i8**, i8*** %t4
  %t6 = getelementptr i8*, i8** %t5, i64 0
  store i8* %t1, i8** %t6
  ret i64 0
}
define i64 @"盒子__加_"(i8* %"this_arg", i8* %"其他_arg") {
entry:
  %"此" = alloca i8*
  store i8* %"this_arg", i8** %"此"
  %"其他" = alloca i8*
  store i8* %"其他_arg", i8** %"其他"
  %t8 = getelementptr inbounds [7 x i8], [7 x i8]* @str.0, i64 0, i64 0
  %t7 = call %XTInstance* @xt_instance_new(i8* %t8, i64 1)
  %t9 = bitcast %XTInstance* %t7 to i8*
  %t10 = load i8*, i8** %"此"
  %t11 = bitcast i8* %t10 to %XTInstance*
  %t12 = getelementptr %XTInstance, %XTInstance* %t11, i32 0, i32 3
  %t13 = load i8**, i8*** %t12
  %t14 = getelementptr i8*, i8** %t13, i64 0
  %t15 = load i8*, i8** %t14
  %t16 = load i8*, i8** %"其他"
  %t17 = bitcast i8* %t16 to %XTInstance*
  %t18 = getelementptr %XTInstance, %XTInstance* %t17, i32 0, i32 3
  %t19 = load i8**, i8*** %t18
  %t20 = getelementptr i8*, i8** %t19, i64 0
  %t21 = load i8*, i8** %t20
  %t22 = call i64 @xt_to_int(i8* %t15)
  %t23 = call i64 @xt_to_int(i8* %t21)
  %t24 = add i64 %t22, %t23
  %t25 = call i8* @xt_int_new(i64 %t24)
  call i64 @"盒子_造"(i8* %t9, i8* %t25)
  %t26 = ptrtoint %XTInstance* %t7 to i64
  ret i64 %t26
  ret i64 0
}

define i32 @main() {
entry:
  call void @xt_init()
  %t28 = getelementptr inbounds [7 x i8], [7 x i8]* @str.0, i64 0, i64 0
  %t27 = call %XTInstance* @xt_instance_new(i8* %t28, i64 1)
  %t29 = bitcast %XTInstance* %t27 to i8*
  %t30 = call i8* @xt_int_new(i64 10)
  call i64 @"盒子_造"(i8* %t29, i8* %t30)
  store %XTInstance* %t27, %XTInstance** @"b1"
  %t32 = getelementptr inbounds [7 x i8], [7 x i8]* @str.0, i64 0, i64 0
  %t31 = call %XTInstance* @xt_instance_new(i8* %t32, i64 1)
  %t33 = bitcast %XTInstance* %t31 to i8*
  %t34 = call i8* @xt_int_new(i64 20)
  call i64 @"盒子_造"(i8* %t33, i8* %t34)
  store %XTInstance* %t31, %XTInstance** @"b2"
  %t35 = load %XTInstance*, %XTInstance** @"b1"
  %t36 = load %XTInstance*, %XTInstance** @"b2"
  %t37 = bitcast %XTInstance* %t35 to i8*
  %t38 = bitcast %XTInstance* %t36 to i8*
  %t39 = call i64 @"盒子__加_"(i8* %t37, i8* %t38)
  store i64 %t39, i64* @"b3"
  %t40 = load i64, i64* @"b3"
  %t41 = inttoptr i64 %t40 to %XTInstance*
  %t42 = getelementptr %XTInstance, %XTInstance* %t41, i32 0, i32 3
  %t43 = load i8**, i8*** %t42
  %t44 = getelementptr i8*, i8** %t43, i64 0
  %t45 = load i8*, i8** %t44
  %t46 = call %XTString* @xt_obj_to_string(i8* %t45)
  call void @xt_print_string(%XTString* %t46)
  ret i32 0
}
