; XuanTie v0.13.3 LLVM Backend
target datalayout = "e-m:w-p270:32:32-p271:32:32-p272:64:64-i64:64-f80:128-n8:16:32:64-S128"
target triple = "x86_64-pc-windows-msvc"

@str.0 = private unnamed_addr constant [11 x i8] c"总和是:\00"

%XTString = type { i32, i32, i8*, i64 }
%XTArray = type { i32, i32, i8**, i64, i64 }
%XTInstance = type { i32, i32, i8*, i8** }
%XTResult = type { i32, i32, i1, i8*, i8* }
declare void @xt_init()
declare void @xt_print_int(i64)
declare void @xt_print_string(%XTString*)
declare void @xt_print_bool(i1)
declare void @xt_print_float(double)
declare void @xt_print_value(i64)
declare i64 @xt_int_new(i64)
declare i8* @xt_float_new(double)
declare i64 @xt_bool_new(i1)
declare %XTString* @xt_string_new(i8*)
declare %XTArray* @xt_array_new(i64)
declare void @xt_array_append(%XTArray*, i64)
declare %XTInstance* @xt_instance_new(i8*, i64)
declare i8* @xt_result_new(i1, i8*, i8*)
declare %XTString* @xt_string_concat(%XTString*, %XTString*)
declare %XTString* @xt_int_to_string(i64)
declare %XTString* @xt_obj_to_string(i64)
declare void @xt_retain(i64)
declare void @xt_release(i64)
declare i64 @xt_to_int(i64)

@"开始" = global i64 0
@"结束" = global i64 0
@"总和" = global i64 0
@"i" = global i64 0


define i32 @main() {
entry:
  call void @xt_init()
  store i64 1, i64* @"开始"
  store i64 2000001, i64* @"结束"
  store i64 1, i64* @"总和"
  %t1 = load i64, i64* @"开始"
  store i64 %t1, i64* @"i"
  br label %while.cond.1
while.cond.1:
  %t2 = load i64, i64* @"i"
  %t3 = load i64, i64* @"结束"
  %t5 = ashr i64 %t2, 1
  %t6 = ashr i64 %t3, 1
  %t4 = icmp slt i64 %t5, %t6
  br i1 %t4, label %while.body.2, label %while.end.3
while.body.2:
  %t7 = load i64, i64* @"总和"
  %t8 = load i64, i64* @"i"
  %t10 = ashr i64 %t7, 1
  %t11 = ashr i64 %t8, 1
  %t12 = add i64 %t10, %t11
  %t13 = shl i64 %t12, 1
  %t9 = or i64 %t13, 1
  store i64 %t9, i64* @"总和"
  %t14 = load i64, i64* @"i"
  %t16 = ashr i64 %t14, 1
  %t17 = ashr i64 3, 1
  %t18 = add i64 %t16, %t17
  %t19 = shl i64 %t18, 1
  %t15 = or i64 %t19, 1
  store i64 %t15, i64* @"i"
  br label %while.cond.1
while.end.3:
  %t20 = getelementptr inbounds [11 x i8], [11 x i8]* @str.0, i64 0, i64 0
  %t21 = call %XTString* @xt_string_new(i8* %t20)
  %t22 = bitcast %XTString* %t21 to i8*
  %t23 = ptrtoint i8* %t22 to i64
  call void @xt_print_value(i64 %t23)
  %t24 = load i64, i64* @"总和"
  %t25 = inttoptr i64 %t24 to i8*
  %t26 = ptrtoint i8* %t25 to i64
  call void @xt_print_value(i64 %t26)
  ret i32 0
}
