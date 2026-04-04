package token

type TokenType string

const (
	TOKEN_ILLEGAL TokenType = "ILLEGAL"
	TOKEN_EOF     TokenType = "EOF"

	TOKEN_IDENT  TokenType = "IDENT"
	TOKEN_NUMBER TokenType = "NUMBER"
	TOKEN_FLOAT  TokenType = "FLOAT"
	TOKEN_STRING TokenType = "STRING"
	TOKEN_BOOL   TokenType = "BOOL"

	TOKEN_ASSIGN    TokenType = "="
	TOKEN_PLUS      TokenType = "+"
	TOKEN_MINUS     TokenType = "-"
	TOKEN_MUL       TokenType = "*"
	TOKEN_DIV       TokenType = "/"
	TOKEN_LT        TokenType = "<"
	TOKEN_GT        TokenType = ">"
	TOKEN_EQ        TokenType = "=="
	TOKEN_NEQ       TokenType = "!="
	TOKEN_LPAREN    TokenType = "("
	TOKEN_RPAREN    TokenType = ")"
	TOKEN_COMMA     TokenType = ","
	TOKEN_LBRACE    TokenType = "{"
	TOKEN_RBRACE    TokenType = "}"
	TOKEN_LBRACKET  TokenType = "["
	TOKEN_RBRACKET  TokenType = "]"
	TOKEN_COLON     TokenType = ":"
	TOKEN_AMPERSAND TokenType = "&"
	TOKEN_DOT       TokenType = "."

	TOKEN_PRINT    TokenType = "示"
	TOKEN_VAR      TokenType = "设"
	TOKEN_CONST    TokenType = "常"
	TOKEN_IF       TokenType = "若"
	TOKEN_ELSE_IF  TokenType = "抑"
	TOKEN_ELSE     TokenType = "否"
	TOKEN_WHILE    TokenType = "当"
	TOKEN_LOOP     TokenType = "循"
	TOKEN_FOR      TokenType = "遍历"
	TOKEN_IN       TokenType = "于"
	TOKEN_BREAK    TokenType = "断"
	TOKEN_CONTINUE TokenType = "续"
	TOKEN_FUNCTION TokenType = "函"
	TOKEN_RETURN   TokenType = "返"
	TOKEN_TRUE     TokenType = "真"
	TOKEN_FALSE    TokenType = "假"
	TOKEN_NULL     TokenType = "空"

	TOKEN_TRY         TokenType = "尝试"
	TOKEN_CATCH       TokenType = "捕捉"
	TOKEN_THEN        TokenType = "接着"
	TOKEN_SUCCESS     TokenType = "成功"
	TOKEN_FAILURE     TokenType = "失败"
	TOKEN_ASYNC       TokenType = "异步"
	TOKEN_AWAIT       TokenType = "等待"
	TOKEN_PARALLEL    TokenType = "并行"
	TOKEN_IMPORT      TokenType = "引"
	TOKEN_SERIALIZE   TokenType = "化"
	TOKEN_DESERIALIZE TokenType = "解"
	TOKEN_TYPE_DEF    TokenType = "型"
	TOKEN_NEW         TokenType = "造"
	TOKEN_PRIVATE     TokenType = "私"

	TOKEN_AND TokenType = "且"
	TOKEN_OR  TokenType = "或"
	TOKEN_NOT TokenType = "非"
	TOKEN_IS  TokenType = "是"

	// 类型关键字
	TOKEN_RESULT_TYPE TokenType = "结果"
	TOKEN_STRING_TYPE TokenType = "字"
	TOKEN_INT_TYPE    TokenType = "整"
	TOKEN_FLOAT_TYPE  TokenType = "小数"
	TOKEN_BOOL_TYPE   TokenType = "逻"
	TOKEN_ARRAY_TYPE  TokenType = "数组"
	TOKEN_DICT_TYPE   TokenType = "字典"
)

type Token struct {
	Type    TokenType
	Literal string
	Line    int
	Column  int
}
