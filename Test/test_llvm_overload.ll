; XuanTie v0.13.2 LLVM Backend
target datalayout = "e-m:w-p270:32:32-p271:32:32-p272:64:64-i64:64-f80:128-n8:16:32:64-S128"
target triple = "x86_64-pc-windows-msvc"

@str.0 = private unnamed_addr constant [4 x i8] c"点\00"
@str.1 = private unnamed_addr constant [2 x i8] c"(\00"
@str.2 = private unnamed_addr constant [3 x i8] c", \00"
@str.3 = private unnamed_addr constant [2 x i8] c")\00"

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

@"p1" = global %XTInstance* null
@"p2" = global %XTInstance* null
@"p3" = global i64 0

define i64 @"点_造"(i8* %"this_arg", i8* %"x_arg", i8* %"y_arg") {
entry:
  %"此" = alloca i8*
  store i8* %"this_arg", i8** %"此"
  %"x" = alloca i8*
  store i8* %"x_arg", i8** %"x"
  %"y" = alloca i8*
  store i8* %"y_arg", i8** %"y"
  %t1 = load i8*, i8** %"x"
  %t2 = load i8*, i8** %"此"
  %t3 = bitcast i8* %t2 to %XTInstance*
  %t4 = getelementptr %XTInstance, %XTInstance* %t3, i32 0, i32 3
  %t5 = load i8**, i8*** %t4
  %t6 = getelementptr i8*, i8** %t5, i64 0
  store i8* %t1, i8** %t6
  %t7 = load i8*, i8** %"y"
  %t8 = load i8*, i8** %"此"
  %t9 = bitcast i8* %t8 to %XTInstance*
  %t10 = getelementptr %XTInstance, %XTInstance* %t9, i32 0, i32 3
  %t11 = load i8**, i8*** %t10
  %t12 = getelementptr i8*, i8** %t11, i64 1
  store i8* %t7, i8** %t12
  ret i64 0
}
define i64 @"点__加_"(i8* %"this_arg", i8* %"其他_arg") {
entry:
  %"此" = alloca i8*
  store i8* %"this_arg", i8** %"此"
  %"其他" = alloca i8*
  store i8* %"其他_arg", i8** %"其他"
  %t14 = getelementptr inbounds [4 x i8], [4 x i8]* @str.0, i64 0, i64 0
  %t13 = call %XTInstance* @xt_instance_new(i8* %t14, i64 2)
  %t15 = bitcast %XTInstance* %t13 to i8*
  %t16 = load i8*, i8** %"此"
  %t17 = bitcast i8* %t16 to %XTInstance*
  %t18 = getelementptr %XTInstance, %XTInstance* %t17, i32 0, i32 3
  %t19 = load i8**, i8*** %t18
  %t20 = getelementptr i8*, i8** %t19, i64 0
  %t21 = load i8*, i8** %t20
  %t22 = load i8*, i8** %"其他"
  %t23 = bitcast i8* %t22 to %XTInstance*
  %t24 = getelementptr %XTInstance, %XTInstance* %t23, i32 0, i32 3
  %t25 = load i8**, i8*** %t24
  %t26 = getelementptr i8*, i8** %t25, i64 0
  %t27 = load i8*, i8** %t26
  %t28 = call i64 @xt_to_int(i8* %t21)
  %t29 = call i64 @xt_to_int(i8* %t27)
  %t30 = add i64 %t28, %t29
  %t31 = call i8* @xt_int_new(i64 %t30)
  %t32 = load i8*, i8** %"此"
  %t33 = bitcast i8* %t32 to %XTInstance*
  %t34 = getelementptr %XTInstance, %XTInstance* %t33, i32 0, i32 3
  %t35 = load i8**, i8*** %t34
  %t36 = getelementptr i8*, i8** %t35, i64 1
  %t37 = load i8*, i8** %t36
  %t38 = load i8*, i8** %"其他"
  %t39 = bitcast i8* %t38 to %XTInstance*
  %t40 = getelementptr %XTInstance, %XTInstance* %t39, i32 0, i32 3
  %t41 = load i8**, i8*** %t40
  %t42 = getelementptr i8*, i8** %t41, i64 1
  %t43 = load i8*, i8** %t42
  %t44 = call i64 @xt_to_int(i8* %t37)
  %t45 = call i64 @xt_to_int(i8* %t43)
  %t46 = add i64 %t44, %t45
  %t47 = call i8* @xt_int_new(i64 %t46)
  call i64 @"点_造"(i8* %t15, i8* %t31, i8* %t47)
  %t48 = ptrtoint %XTInstance* %t13 to i64
  ret i64 %t48
  ret i64 0
}
define i64 @"点_描述"(i8* %"this_arg") {
entry:
  %"此" = alloca i8*
  store i8* %"this_arg", i8** %"此"
  %t49 = getelementptr inbounds [2 x i8], [2 x i8]* @str.1, i64 0, i64 0
  %t50 = call %XTString* @xt_string_new(i8* %t49)
  %t51 = load i8*, i8** %"此"
  %t52 = bitcast i8* %t51 to %XTInstance*
  %t53 = getelementptr %XTInstance, %XTInstance* %t52, i32 0, i32 3
  %t54 = load i8**, i8*** %t53
  %t55 = getelementptr i8*, i8** %t54, i64 0
  %t56 = load i8*, i8** %t55
  %t57 = call i64 @xt_to_int(i8* %t50)
  %t58 = call i64 @xt_to_int(i8* %t56)
  %t59 = call i8* @xt_int_new(i64 %t57)
  %t60 = call %XTString* @xt_obj_to_string(i8* %t59)
  %t61 = call i8* @xt_int_new(i64 %t58)
  %t62 = call %XTString* @xt_obj_to_string(i8* %t61)
  %t63 = call %XTString* @xt_string_concat(%XTString* %t60, %XTString* %t62)
  %t64 = getelementptr inbounds [3 x i8], [3 x i8]* @str.2, i64 0, i64 0
  %t65 = call %XTString* @xt_string_new(i8* %t64)
  %t66 = call i64 @xt_to_int(i8* %t63)
  %t67 = call i64 @xt_to_int(i8* %t65)
  %t68 = call i8* @xt_int_new(i64 %t66)
  %t69 = call %XTString* @xt_obj_to_string(i8* %t68)
  %t70 = call i8* @xt_int_new(i64 %t67)
  %t71 = call %XTString* @xt_obj_to_string(i8* %t70)
  %t72 = call %XTString* @xt_string_concat(%XTString* %t69, %XTString* %t71)
  %t73 = load i8*, i8** %"此"
  %t74 = bitcast i8* %t73 to %XTInstance*
  %t75 = getelementptr %XTInstance, %XTInstance* %t74, i32 0, i32 3
  %t76 = load i8**, i8*** %t75
  %t77 = getelementptr i8*, i8** %t76, i64 1
  %t78 = load i8*, i8** %t77
  %t79 = call i64 @xt_to_int(i8* %t72)
  %t80 = call i64 @xt_to_int(i8* %t78)
  %t81 = call i8* @xt_int_new(i64 %t79)
  %t82 = call %XTString* @xt_obj_to_string(i8* %t81)
  %t83 = call i8* @xt_int_new(i64 %t80)
  %t84 = call %XTString* @xt_obj_to_string(i8* %t83)
  %t85 = call %XTString* @xt_string_concat(%XTString* %t82, %XTString* %t84)
  %t86 = getelementptr inbounds [2 x i8], [2 x i8]* @str.3, i64 0, i64 0
  %t87 = call %XTString* @xt_string_new(i8* %t86)
  %t88 = call i64 @xt_to_int(i8* %t85)
  %t89 = call i64 @xt_to_int(i8* %t87)
  %t90 = call i8* @xt_int_new(i64 %t88)
  %t91 = call %XTString* @xt_obj_to_string(i8* %t90)
  %t92 = call i8* @xt_int_new(i64 %t89)
  %t93 = call %XTString* @xt_obj_to_string(i8* %t92)
  %t94 = call %XTString* @xt_string_concat(%XTString* %t91, %XTString* %t93)
  %t95 = ptrtoint %XTString* %t94 to i64
  ret i64 %t95
  ret i64 0
}

define i32 @main() {
entry:
  call void @xt_init()
  %t97 = getelementptr inbounds [4 x i8], [4 x i8]* @str.0, i64 0, i64 0
  %t96 = call %XTInstance* @xt_instance_new(i8* %t97, i64 2)
  %t98 = bitcast %XTInstance* %t96 to i8*
  %t99 = call i8* @xt_int_new(i64 1)
  %t100 = call i8* @xt_int_new(i64 2)
  call i64 @"点_造"(i8* %t98, i8* %t99, i8* %t100)
  store %XTInstance* %t96, %XTInstance** @"p1"
  %t102 = getelementptr inbounds [4 x i8], [4 x i8]* @str.0, i64 0, i64 0
  %t101 = call %XTInstance* @xt_instance_new(i8* %t102, i64 2)
  %t103 = bitcast %XTInstance* %t101 to i8*
  %t104 = call i8* @xt_int_new(i64 10)
  %t105 = call i8* @xt_int_new(i64 20)
  call i64 @"点_造"(i8* %t103, i8* %t104, i8* %t105)
  store %XTInstance* %t101, %XTInstance** @"p2"
  %t106 = load %XTInstance*, %XTInstance** @"p1"
  %t107 = load %XTInstance*, %XTInstance** @"p2"
  %t108 = bitcast %XTInstance* %t106 to i8*
  %t109 = bitcast %XTInstance* %t107 to i8*
  %t110 = call i64 @"点__加_"(i8* %t108, i8* %t109)
  store i64 %t110, i64* @"p3"
  %t111 = load i64, i64* @"p3"
  %t112 = inttoptr i64 %t111 to %XTInstance*
  %t113 = bitcast %XTInstance* %t112 to i8*
  %t114 = call i64 @"点_描述"(i8* %t113)
  %t115 = inttoptr i64 %t114 to i8*
  %t116 = call %XTString* @xt_obj_to_string(i8* %t115)
  call void @xt_print_string(%XTString* %t116)
  ret i32 0
}
