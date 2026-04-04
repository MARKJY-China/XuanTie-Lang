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

	TOKEN_PRINT    TokenType = "打印"
	TOKEN_VAR      TokenType = "变量"
	TOKEN_CONST    TokenType = "常量"
	TOKEN_IF       TokenType = "如果"
	TOKEN_ELSE     TokenType = "否则"
	TOKEN_WHILE    TokenType = "当"
	TOKEN_FUNCTION TokenType = "函数"
	TOKEN_RETURN   TokenType = "返回"
	TOKEN_TRUE     TokenType = "真"
	TOKEN_FALSE    TokenType = "假"
	TOKEN_NULL     TokenType = "空"

	TOKEN_TRY      TokenType = "尝试"
	TOKEN_CATCH    TokenType = "捕捉"
	TOKEN_THEN     TokenType = "接着"
	TOKEN_SUCCESS  TokenType = "成功"
	TOKEN_FAILURE  TokenType = "失败"
	TOKEN_ASYNC    TokenType = "异步"
	TOKEN_AWAIT    TokenType = "等待"
	TOKEN_PARALLEL TokenType = "并行"
	TOKEN_IMPORT   TokenType = "引用"

	TOKEN_AND TokenType = "且"
	TOKEN_OR  TokenType = "或"
	TOKEN_NOT TokenType = "非"

	// 类型关键字
	TOKEN_RESULT_TYPE TokenType = "结果"
	TOKEN_STRING_TYPE TokenType = "字符串"
	TOKEN_INT_TYPE    TokenType = "整数"
	TOKEN_FLOAT_TYPE  TokenType = "小数"
	TOKEN_BOOL_TYPE   TokenType = "逻辑"
	TOKEN_ARRAY_TYPE  TokenType = "数组"
	TOKEN_DICT_TYPE   TokenType = "字典"
)

type Token struct {
	Type    TokenType
	Literal string
	Line    int
	Column  int
}
