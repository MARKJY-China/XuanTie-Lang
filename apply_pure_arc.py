#!/usr/bin/env python3
"""Apply pure ARC fixes to Go seed compiler. Single clean script."""
import sys

with open('compiler/llvm.go', 'r', encoding='utf-8') as f:
    content = f.read()

ok = 0

# Add isThis helper before emitAlloca
helper = '''func (c *LLVMCompiler) isThis(expr ast.Expression) bool {
\tif ident, ok := expr.(*ast.Identifier); ok && ident.Value == "此" {
\t\treturn true
\t}
\treturn false
}

'''
content = content.replace(
    'func (c *LLVMCompiler) emitAlloca',
    helper + 'func (c *LLVMCompiler) emitAlloca'
)
ok += 1
print(f"+ isThis helper")

# Fix 1: Method call dispatch (~line 1904)
old1 = '\t\tc.emit("  call void @xt_release(i64 %s)", objXt)\n\t\treturn final, "i64", objClass'
new1 = '\t\tif !c.isThis(e.Object) {\n\t\t\tc.emit("  call void @xt_release(i64 %s)", objXt)\n\t\t}\n\t\treturn final, "i64", objClass'
assert old1 in content, "FIX1: pattern not found!"
content = content.replace(old1, new1)
ok += 1
print(f"+ fix1: method dispatch (e.Object)")

# Fix 2: Operator overload (~line 2207)
old2 = '\t\t\tc.emit("  call void @xt_release(i64 %s)", objXt)\n\t\t\t}\n\t\t\treturn finalRes, "i64", ""'
new2 = '\t\t\tif !c.isThis(e.Left) {\n\t\t\t\tc.emit("  call void @xt_release(i64 %s)", objXt)\n\t\t\t}\n\t\t\t}\n\t\t\treturn finalRes, "i64", ""'
assert old2 in content, "FIX2: pattern not found!"
content = content.replace(old2, new2)
ok += 1
print(f"+ fix2: operator overload (e.Left)")

# Fix 3: Member call expression (~line 2713)
old3 = '\t\tc.emit("  call void @xt_dict_set(i64 %s, i64 %s, i64 %s)", objXt, keyXt, xtVal)\n\t\tc.emit("  call void @xt_release(i64 %s)", objXt)'
new3 = '\t\tc.emit("  call void @xt_dict_set(i64 %s, i64 %s, i64 %s)", objXt, keyXt, xtVal)\n\t\tif !c.isThis(left.Object) {\n\t\t\tc.emit("  call void @xt_release(i64 %s)", objXt)\n\t\t}'
assert old3 in content, "FIX3: pattern not found!"
content = content.replace(old3, new3)
ok += 1
print(f"+ fix3: member call (left.Object)")

assert ok == 4, f"Only {ok}/4 applied!"
with open('compiler/llvm.go', 'w', encoding='utf-8') as f:
    f.write(content)
print(f"\nAll {ok} changes applied successfully!")
