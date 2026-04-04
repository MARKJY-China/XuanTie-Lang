package lexer

import (
	"strings"
	"unicode"
	"unicode/utf8"
	"xuantie/token"
)

type Lexer struct {
	input        string
	position     int  // 当前字节位置
	readPosition int  // 下一个读取字节位置
	ch           rune // 当前字符 (rune)
	line         int  // 当前行号
	column       int  // 当前列号
}

func New(input string) *Lexer {
	l := &Lexer{input: input, line: 1, column: 0}
	l.readChar()
	return l
}

func (l *Lexer) readChar() {
	if l.readPosition >= len(l.input) {
		l.ch = 0 // EOF
	} else {
		r, size := utf8.DecodeRuneInString(l.input[l.readPosition:])
		l.ch = r
		l.position = l.readPosition
		l.readPosition += size
	}
	if l.ch == '\n' {
		l.line++
		l.column = 0
	} else {
		l.column++
	}
}

func (l *Lexer) peekChar() rune {
	if l.readPosition >= len(l.input) {
		return 0
	}
	r, _ := utf8.DecodeRuneInString(l.input[l.readPosition:])
	return r
}

func (l *Lexer) NextToken() token.Token {
	l.skipWhitespace()

	var tok token.Token
	line := l.line
	col := l.column

	switch l.ch {
	case 0:
		tok = token.Token{Type: token.TOKEN_EOF, Literal: "", Line: line, Column: col}
	case '=':
		if l.peekChar() == '=' {
			ch := l.ch
			l.readChar()
			literal := string(ch) + string(l.ch)
			tok = token.Token{Type: token.TOKEN_EQ, Literal: literal, Line: line, Column: col}
		} else {
			tok = token.Token{Type: token.TOKEN_ASSIGN, Literal: string(l.ch), Line: line, Column: col}
		}
	case '+':
		tok = token.Token{Type: token.TOKEN_PLUS, Literal: string(l.ch), Line: line, Column: col}
	case '-':
		tok = token.Token{Type: token.TOKEN_MINUS, Literal: string(l.ch), Line: line, Column: col}
	case '*':
		tok = token.Token{Type: token.TOKEN_MUL, Literal: string(l.ch), Line: line, Column: col}
	case '/':
		if l.peekChar() == '/' {
			l.skipComment()
			return l.NextToken()
		}
		tok = token.Token{Type: token.TOKEN_DIV, Literal: string(l.ch), Line: line, Column: col}
	case '<':
		tok = token.Token{Type: token.TOKEN_LT, Literal: string(l.ch), Line: line, Column: col}
	case '>':
		tok = token.Token{Type: token.TOKEN_GT, Literal: string(l.ch), Line: line, Column: col}
	case '!':
		if l.peekChar() == '=' {
			ch := l.ch
			l.readChar()
			literal := string(ch) + string(l.ch)
			tok = token.Token{Type: token.TOKEN_NEQ, Literal: literal, Line: line, Column: col}
		} else {
			tok = token.Token{Type: token.TOKEN_ILLEGAL, Literal: string(l.ch), Line: line, Column: col}
		}
	case '(':
		tok = token.Token{Type: token.TOKEN_LPAREN, Literal: string(l.ch), Line: line, Column: col}
	case ')':
		tok = token.Token{Type: token.TOKEN_RPAREN, Literal: string(l.ch), Line: line, Column: col}
	case ',':
		tok = token.Token{Type: token.TOKEN_COMMA, Literal: string(l.ch), Line: line, Column: col}
	case '"':
		tok.Type = token.TOKEN_STRING
		tok.Literal = l.readString()
		tok.Line = line
		tok.Column = col
	case '{':
		tok = token.Token{Type: token.TOKEN_LBRACE, Literal: string(l.ch), Line: line, Column: col}
	case '}':
		tok = token.Token{Type: token.TOKEN_RBRACE, Literal: string(l.ch), Line: line, Column: col}
	case '[':
		tok = token.Token{Type: token.TOKEN_LBRACKET, Literal: string(l.ch), Line: line, Column: col}
	case ']':
		tok = token.Token{Type: token.TOKEN_RBRACKET, Literal: string(l.ch), Line: line, Column: col}
	case ':':
		tok = token.Token{Type: token.TOKEN_COLON, Literal: string(l.ch), Line: line, Column: col}
	case '&':
		tok = token.Token{Type: token.TOKEN_AMPERSAND, Literal: string(l.ch), Line: line, Column: col}
	case '.':
		if isDigit(l.peekChar()) {
			tok.Literal, _ = l.readNumber()
			tok.Type = token.TOKEN_FLOAT
			tok.Line = line
			tok.Column = col
			return tok
		}
		tok = token.Token{Type: token.TOKEN_DOT, Literal: string(l.ch), Line: line, Column: col}
	default:
		if isLetter(l.ch) {
			tok.Literal = l.readIdentifier()
			tok.Type = lookupKeyword(tok.Literal)
			tok.Line = line
			tok.Column = col
			return tok
		} else if isDigit(l.ch) {
			var isFloat bool
			tok.Literal, isFloat = l.readNumber()
			if isFloat {
				tok.Type = token.TOKEN_FLOAT
			} else {
				tok.Type = token.TOKEN_NUMBER
			}
			tok.Line = line
			tok.Column = col
			return tok
		} else {
			tok = token.Token{Type: token.TOKEN_ILLEGAL, Literal: string(l.ch), Line: line, Column: col}
		}
	}

	l.readChar()
	return tok
}

func (l *Lexer) skipWhitespace() {
	for l.ch == ' ' || l.ch == '\t' || l.ch == '\n' || l.ch == '\r' {
		l.readChar()
	}
}

func (l *Lexer) skipComment() {
	for l.ch != '\n' && l.ch != 0 {
		l.readChar()
	}
	l.skipWhitespace()
}

func (l *Lexer) readIdentifier() string {
	start := l.position
	for isLetter(l.ch) || isDigit(l.ch) {
		l.readChar()
	}
	return l.input[start:l.position]
}

func isLetter(ch rune) bool {
	return unicode.IsLetter(ch) || ch == '_'
}

func lookupKeyword(ident string) token.TokenType {
	switch ident {
	case "示", "打印":
		return token.TOKEN_PRINT
	case "设", "变量":
		return token.TOKEN_VAR
	case "常", "常量":
		return token.TOKEN_CONST
	case "若":
		return token.TOKEN_IF
	case "抑":
		return token.TOKEN_ELSE_IF
	case "否":
		return token.TOKEN_ELSE
	case "当":
		return token.TOKEN_WHILE
	case "循":
		return token.TOKEN_LOOP
	case "遍历":
		return token.TOKEN_FOR
	case "于":
		return token.TOKEN_IN
	case "断", "跳出":
		return token.TOKEN_BREAK
	case "续", "继续":
		return token.TOKEN_CONTINUE
	case "函", "函数":
		return token.TOKEN_FUNCTION
	case "返", "返回":
		return token.TOKEN_RETURN
	case "真":
		return token.TOKEN_TRUE
	case "假":
		return token.TOKEN_FALSE
	case "空":
		return token.TOKEN_NULL
	case "尝试":
		return token.TOKEN_TRY
	case "捕捉":
		return token.TOKEN_CATCH
	case "接着":
		return token.TOKEN_THEN
	case "成功":
		return token.TOKEN_SUCCESS
	case "失败":
		return token.TOKEN_FAILURE
	case "异步":
		return token.TOKEN_ASYNC
	case "等待":
		return token.TOKEN_AWAIT
	case "并行":
		return token.TOKEN_PARALLEL
	case "引", "引用":
		return token.TOKEN_IMPORT
	case "且":
		return token.TOKEN_AND
	case "或":
		return token.TOKEN_OR
	case "非":
		return token.TOKEN_NOT
	case "是":
		return token.TOKEN_IS
	case "等于":
		return token.TOKEN_EQ
	case "结果":
		return token.TOKEN_RESULT_TYPE
	case "字", "字符串":
		return token.TOKEN_STRING_TYPE
	case "整", "整数":
		return token.TOKEN_INT_TYPE
	case "小数":
		return token.TOKEN_FLOAT_TYPE
	case "逻", "逻辑":
		return token.TOKEN_BOOL_TYPE
	case "数组":
		return token.TOKEN_ARRAY_TYPE
	case "字典":
		return token.TOKEN_DICT_TYPE
	default:
		return token.TOKEN_IDENT
	}
}

func (l *Lexer) readNumber() (string, bool) {
	start := l.position
	isFloat := false
	for isDigit(l.ch) {
		l.readChar()
	}
	if l.ch == '.' {
		isFloat = true
		l.readChar()
		for isDigit(l.ch) {
			l.readChar()
		}
	}
	return l.input[start:l.position], isFloat
}

func isDigit(ch rune) bool {
	return unicode.IsDigit(ch)
}

func (l *Lexer) readString() string {
	l.readChar() // 跳过开头的 "
	var out strings.Builder
	for l.ch != '"' && l.ch != 0 {
		if l.ch == '\\' {
			l.readChar()
			switch l.ch {
			case 'n':
				out.WriteRune('\n')
			case 't':
				out.WriteRune('\t')
			case 'r':
				out.WriteRune('\r')
			case 'b':
				out.WriteRune('\b')
			case 'f':
				out.WriteRune('\f')
			case '"':
				out.WriteRune('"')
			case '\\':
				out.WriteRune('\\')
			default:
				out.WriteRune(l.ch)
			}
		} else {
			out.WriteRune(l.ch)
		}
		l.readChar()
	}
	return out.String()
}
