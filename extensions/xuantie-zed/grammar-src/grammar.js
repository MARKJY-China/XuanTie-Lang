// grammar.js — 玄铁语言 tree-sitter grammar（Zed 编辑器语法高亮用）
// 依据：token/token.go 关键字全集 + examples/ 真实代码形态
// 关键字：中文单字，靠 tree-sitter 字面量优先 + 最长匹配与标识符区分

module.exports = grammar({
  name: 'xuantie',

  word: $ => $.identifier,

  extras: $ => [/\s/],

  rules: {
    // 程序 = 语句序列（含注释）
    source_file: $ => repeat(choice($.comment, $.statement)),

    // ---- 注释：// 行注释 ----
    comment: $ => token(seq('//', /.*/)),

    // ---- 语句 ----
    statement: $ => choice(
      $.import_statement,
      $.variable_declaration,
      $.constant_declaration,
      $.function_definition,
      $.if_statement,
      $.while_statement,
      $.for_statement,
      $.loop_statement,
      $.return_statement,
      $.break_statement,
      $.continue_statement,
      $.terminate_statement,
      $.try_statement,
      $.async_statement,
      $.await_statement,
      $.parallel_statement,
      $.match_statement,
      $.type_definition,
      $.expression_statement,
    ),

    // ---- 引 "库" 予 别名 ----
    import_statement: $ => seq(
      choice('引', '引用'),
      $.string,
      optional(seq('予', $.identifier)),
    ),

    // ---- 设 名 = 表达式 / 设 名: 类型 = 表达式（前可加 私/公/护/弱 修饰） ----
    variable_declaration: $ => seq(
      optional(choice('私', '公', '护', '弱')),
      choice('设', '变量'),
      field('name', $.identifier),
      optional(seq(':', field('type', $._type))),
      optional(seq('=', field('value', $.expression))),
    ),

    // ---- 常 ----
    constant_declaration: $ => seq(
      choice('常', '常量'),
      field('name', $.identifier),
      optional(seq(':', field('type', $._type))),
      optional(seq('=', field('value', $.expression))),
    ),

    // ---- 函 名(参数): 返回类型 { }（前可加 私/公/护/覆/弱/外 修饰；匿名函数见 anonymous_function） ----
    function_definition: $ => seq(
      optional(choice('私', '公', '护', '覆', '弱', '外')),
      choice('函', '函数'),
      field('name', $.identifier),
      field('parameters', $.parameters),
      optional(seq(':', field('return_type', $._type))),
      field('body', $.block),
    ),

    parameters: $ => seq(
      '(',
      optional(seq(
        commaSep($._parameter),
        optional(','),
      )),
      ')',
    ),

    _parameter: $ => seq(
      field('name', $.identifier),
      optional(seq(':', field('type', $._type))),
    ),

    block: $ => seq('{', repeat(choice($.comment, $.statement)), '}'),

    // ---- 若 条件 { } 抑 ... 否 { } ----
    if_statement: $ => seq(
      '若',
      field('condition', $.expression),
      field('consequence', $.block),
      repeat(seq('抑', field('condition', $.expression), field('consequence', $.block))),
      optional(seq('否', field('alternative', $.block))),
    ),

    // ---- 当 条件 { } ----
    while_statement: $ => seq(
      '当',
      field('condition', $.expression),
      field('body', $.block),
    ),

    // ---- 循 [变量 于 集合] { } ----
    loop_statement: $ => seq(
      '循',
      optional(seq(field('element', $.identifier), '于', field('collection', $.expression))),
      field('body', $.block),
    ),

    // ---- 遍历 集合 { } / 遍历 变量 于 集合 { } ----
    for_statement: $ => seq(
      '遍历',
      optional(seq(field('element', $.identifier), optional(seq('于', field('collection', $.expression))))),
      field('body', $.block),
    ),

    // ---- 返 [表达式] ----
    return_statement: $ => prec.right(1, seq(
      choice('返', '返回'),
      optional(field('value', $.expression)),
    )),

    break_statement: $ => choice('断', '跳出'),
    continue_statement: $ => choice('续', '继续'),

    // ---- 终 ----
    terminate_statement: $ => '终',

    // ---- 尝试 { } 捕捉 ... ----
    try_statement: $ => seq(
      '尝试',
      field('body', $.block),
      optional(seq('捕捉', field('catch', $.block))),
      optional(seq('接着', field('then', $.block))),
      optional(seq('成功', field('success', $.block))),
      optional(seq('失败', field('failure', $.block))),
    ),

    // ---- 异步/等待/并行 修饰 ----
    async_statement: $ => seq('异步', field('body', $.expression)),
    await_statement: $ => seq('等待', field('body', $.expression)),
    parallel_statement: $ => seq('并行', field('body', $.expression)),

    // ---- 匹配 表达式 { } ----
    match_statement: $ => seq(
      '匹配',
      field('value', $.expression),
      field('body', $.block),
    ),

    // ---- 型 名 [承 父] { } / 口 名 { } ----
    type_definition: $ => seq(
      choice('型', '口'),
      field('name', $.identifier),
      optional(seq('承', field('parent', $._type))),
      field('body', $.block),
    ),

    // ---- 表达式语句 ----
    expression_statement: $ => $.expression,

    // ---- 表达式 ----
    expression: $ => choice(
      $.string,
      $.number,
      $.constant,
      $.identifier,
      $.call_expression,
      $.property_expression,
      $.binary_expression,
      $.unary_expression,
      $.parenthesized_expression,
      $.index_expression,
      $.dictionary,
      $.array,
      $.range_expression,
      $.anonymous_function,
      $.new_expression,
    ),

    // ---- 字符串："..." / “...”（含 #{插值} 时整体高亮，插值节点可选迭代） ----
    string: $ => choice(
      token(seq('"', /[^"\n]*/, '"')),
      token(seq('“', /[^”\n]*/, '”')),
    ),

    number: $ => token(/-?\d+(\.\d+)?/),

    constant: $ => choice('真', '假', '空', '此'),

    // ---- 标识符：中文/英文/下划线开头，字母数字下划线延续，可带 ?（空安全） ----
    identifier: $ => token(/[\p{L}_][\p{L}\p{N}_]*\??/),

    // ---- 调用：标识符/属性(实参...) ----
    call_expression: $ => prec(2, seq(
      field('function', choice($.identifier, $.property_expression)),
      field('arguments', $.arguments),
    )),

    arguments: $ => seq(
      '(',
      optional(seq(
        commaSep($.expression),
        optional(','),
      )),
      ')',
    ),

    // ---- 属性/库访问：表达式 . 标识符（时.微秒、R.绘文字） ----
    property_expression: $ => prec(1, seq(
      field('object', $.expression),
      '.',
      field('property', $.identifier),
    )),

    // ---- 二元运算 ----
    binary_expression: $ => prec.left(1, seq(
      field('left', $.expression),
      field('operator', $.operator),
      field('right', $.expression),
    )),

    operator: $ => choice(
      // 算术
      '+', '-', '*', '/', '%',
      // 比较
      '==', '!=', '<=', '>=', '<', '>', '等于',
      // 逻辑
      '且', '或', '是', '&', '|',
      // 位运算
      '位与', '位或', '异或', '左移', '右移', '取反',
    ),

    // ---- 一元：非 表达式 / - 表达式 ----
    unary_expression: $ => prec(2, seq(
      choice('非', '-'),
      field('argument', $.expression),
    )),

    parenthesized_expression: $ => seq('(', field('inner', $.expression), ')'),

    // ---- 索引：表达式[表达式] ----
    index_expression: $ => prec(1, seq(
      field('object', $.expression),
      '[',
      field('index', $.expression),
      ']',
    )),

    // ---- 范围：1..5 / a..b（操作数限定原子表达式，避免与属性/二元/索引纠缠） ----
    range_expression: $ => prec(1, seq(
      field('start', choice($.number, $.identifier, $.string)),
      '..',
      field('end', choice($.number, $.identifier, $.string)),
    )),

    // ---- 字典/选项表：{ 键: 值, ... } ----
    dictionary: $ => seq(
      '{',
      optional(seq(
        commaSep(seq(field('key', $.expression), ':', field('value', $.expression))),
        optional(','),
      )),
      '}',
    ),

    // ---- 数组：[a, b, ...] ----
    array: $ => seq(
      '[',
      optional(seq(
        commaSep($.expression),
        optional(','),
      )),
      ']',
    ),

    // ---- 匿名函数表达式：函(参数) { } ----
    anonymous_function: $ => seq(
      choice('函', '函数'),
      field('parameters', $.parameters),
      field('body', $.block),
    ),

    // ---- 造：new 表达式（造 类型(...)） ----
    new_expression: $ => seq(
      '造',
      field('type', $._type),
      field('arguments', $.arguments),
    ),

    // ---- 类型注解用：整 小数 字 布尔 数组 字典 结果 任务 字节 字符串 整数 逻辑 标识符 数组[...] 字典[..,..] ----
    _type: $ => prec.left(1, choice(
      '整', '整数', '小数', '字', '字符串', '布尔', '逻辑', '空', '数组', '字典', '字节', '结果', '任务',
      $.identifier,
      seq('数组', '[', $._type, ']'),
      seq('字典', '[', $._type, ',', $._type, ']'),
    )),
  },
});

function commaSep(rule) {
  return seq(rule, repeat(seq(',', rule)));
}
