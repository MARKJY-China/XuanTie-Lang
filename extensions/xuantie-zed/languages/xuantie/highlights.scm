; 玄铁语言 Zed 高亮规则（tree-sitter 查询 → Zed 标准捕获）
; 节点名来源：grammar-src/grammar.js 生成解析树（tree-sitter parse 验证）

; ---- 注释 ----
(comment) @comment

; ---- 控制流关键字 ----
["若" "抑" "否" "当" "循" "遍历" "于" "断" "跳出" "续" "继续" "返" "返回"
 "匹配" "尝试" "捕捉" "接着" "成功" "失败" "异步" "等待" "并行"] @keyword.control
(terminate_statement) @keyword.control

; ---- 声明/修饰关键字 ----
["设" "变量" "常" "常量" "函" "函数" "型" "口" "造" "承" "私" "公" "护" "覆"
 "引" "引用" "予"] @keyword

; ---- 库操作内置函数（谓词匹配：示/打印/化/解/连/听/求/执/输/道） ----
(call_expression function: (identifier) @function.builtin
  (#any-of? @function.builtin "示" "打印" "化" "解" "连" "听" "求" "执" "输" "道"))

; ---- 类型 ----
["整" "整数" "小数" "字" "字符串" "布尔" "逻辑" "空" "数组" "字典" "字节" "结果" "任务"] @type.builtin

; ---- 逻辑/位运算操作符 ----
["且" "或" "非" "是" "位与" "位或" "异或" "左移" "右移" "取反"] @operator

; ---- 常量 ----
["真" "假" "空" "此"] @constant

; ---- 字面量 ----
(string) @string
(number) @number

; ---- 标识符 ----
(identifier) @variable

; ---- 函数 ----
(function_definition name: (identifier) @function)
(call_expression function: (identifier) @function)
(call_expression function: (property_expression property: (identifier) @function))
(function_definition return_type: (identifier) @type)

; ---- 属性/库访问 ----
(property_expression property: (identifier) @property)

; ---- 字典键 ----
(dictionary key: (expression (identifier) @property))

; ---- 参数 ----
(parameters name: (identifier) @parameter)

; ---- 操作符 ----
(operator) @operator
