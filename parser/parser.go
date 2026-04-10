package parser

import (
	"fmt"
	"strconv"
	"strings"
	"xuantie/ast"
	"xuantie/lexer"
	"xuantie/token"
)

const (
	LOWEST      = iota
	LOGICAL_OR  // 或
	LOGICAL_AND // 且
	CONCAT      // &
	EQUALS      // == !=
	LESSGREATER // < >
	SUM         // + -
	PRODUCT     // * /
	CALL        // 函数调用
	DOT         // .
	INDEX       // []
)

var precedences = map[token.TokenType]int{
	token.TOKEN_OR:        LOGICAL_OR,
	token.TOKEN_AND:       LOGICAL_AND,
	token.TOKEN_EQ:        EQUALS,
	token.TOKEN_IS:        EQUALS,
	token.TOKEN_NEQ:       EQUALS,
	token.TOKEN_LT:        LESSGREATER,
	token.TOKEN_GT:        LESSGREATER,
	token.TOKEN_LE:        LESSGREATER,
	token.TOKEN_GE:        LESSGREATER,
	token.TOKEN_PLUS:      SUM,
	token.TOKEN_MINUS:     SUM,
	token.TOKEN_MUL:       PRODUCT,
	token.TOKEN_DIV:       PRODUCT,
	token.TOKEN_MOD:       PRODUCT,
	token.TOKEN_AMPERSAND: CONCAT,
	token.TOKEN_LPAREN:    CALL,
	token.TOKEN_DOT:       DOT,
	token.TOKEN_LBRACKET:  INDEX,
}

type Parser struct {
	l      *lexer.Lexer
	cur    token.Token
	peek   token.Token
	errors []string
}

func New(l *lexer.Lexer) *Parser {
	p := &Parser{l: l, errors: []string{}}
	p.nextToken()
	p.nextToken()
	return p
}

func (p *Parser) nextToken() {
	p.cur = p.peek
	p.peek = p.l.NextToken()
}

func (p *Parser) Errors() []string {
	return p.errors
}

func (p *Parser) ParseProgram() *ast.Program {
	program := &ast.Program{Statements: []ast.Statement{}}
	for p.cur.Type != token.TOKEN_EOF {
		stmt := p.parseStatement()
		if stmt != nil {
			program.Statements = append(program.Statements, stmt)
		}
		p.nextToken()
	}
	return program
}

func (p *Parser) parseStatement() ast.Statement {
	switch p.cur.Type {
	case token.TOKEN_PRINT:
		return p.parsePrintStatement()
	case token.TOKEN_VAR, token.TOKEN_CONST, token.TOKEN_PRIVATE, token.TOKEN_PUBLIC, token.TOKEN_PROTECTED:
		return p.parseMemberStatement()
	case token.TOKEN_IF:
		return p.parseIfStatement()
	case token.TOKEN_WHILE:
		return p.parseWhileStatement()
	case token.TOKEN_MATCH:
		return p.parseMatchStatement()
	case token.TOKEN_LOOP:
		return p.parseLoopStatement()
	case token.TOKEN_FOR:
		return p.parseForStatement()
	case token.TOKEN_BREAK:
		return &ast.BreakStatement{Token: p.cur}
	case token.TOKEN_CONTINUE:
		return &ast.ContinueStatement{Token: p.cur}
	case token.TOKEN_TRY:
		return p.parseTryCatchStatement()
	case token.TOKEN_RETURN:
		return p.parseReturnStatement()
	case token.TOKEN_IMPORT:
		return p.parseExpressionStatement()
	case token.TOKEN_TYPE_DEF:
		return p.parseTypeDefinitionStatement("")
	case token.TOKEN_INTERFACE:
		return p.parseInterfaceStatement("")
	case token.TOKEN_FUNCTION:
		if p.peek.Type == token.TOKEN_IDENT || p.peek.Type == token.TOKEN_NEW {
			return p.parseFunctionStatement("")
		}
		return p.parseExpressionStatement()
	case token.TOKEN_IDENT:
		if p.peek.Type == token.TOKEN_ASSIGN {
			return p.parseAssignStatement()
		}
		return p.parseExpressionStatement()
	default:
		return p.parseExpressionStatement()
	}
}

func (p *Parser) parseReturnStatement() *ast.ReturnStatement {
	stmt := &ast.ReturnStatement{Token: p.cur}
	p.nextToken()
	stmt.ReturnValue = p.parseExpression(LOWEST)
	return stmt
}

func (p *Parser) parseImportExpression() ast.Expression {
	exp := &ast.ImportExpression{Token: p.cur}

	if !p.expectPeek(token.TOKEN_STRING) {
		return nil
	}

	exp.Path = p.cur.Literal

	// 支持 引 "路径" 予 别名
	if p.peek.Type == token.TOKEN_GIVE {
		p.nextToken() // cur: 予
		if !p.expectPeek(token.TOKEN_IDENT) {
			return nil
		}
		exp.Alias = &ast.Identifier{Token: p.cur, Value: p.cur.Literal}
	}

	return exp
}

func (p *Parser) parsePrintStatement() *ast.PrintStatement {
	stmt := &ast.PrintStatement{Token: p.cur}
	if !p.expectPeek(token.TOKEN_LPAREN) {
		return nil
	}
	p.nextToken()
	stmt.Value = p.parseExpression(LOWEST)
	if !p.expectPeek(token.TOKEN_RPAREN) {
		return nil
	}
	return stmt
}

func (p *Parser) parseMemberStatement() ast.Statement {
	visibility := token.TokenType("")
	if p.cur.Type == token.TOKEN_PRIVATE || p.cur.Type == token.TOKEN_PUBLIC || p.cur.Type == token.TOKEN_PROTECTED {
		visibility = p.cur.Type
		p.nextToken()
	}

	if p.cur.Type == token.TOKEN_FUNCTION {
		return p.parseFunctionStatement(visibility)
	}

	if p.cur.Type == token.TOKEN_TYPE_DEF {
		return p.parseTypeDefinitionStatement(visibility)
	}

	if p.cur.Type == token.TOKEN_INTERFACE {
		return p.parseInterfaceStatement(visibility)
	}

	return p.parseVarStatement(visibility)
}

func (p *Parser) parseVarStatement(visibility token.TokenType) *ast.VarStatement {
	stmt := &ast.VarStatement{Token: p.cur, Visibility: visibility}

	if !p.expectPeek(token.TOKEN_IDENT) {
		return nil
	}

	stmt.Name = &ast.Identifier{Token: p.cur, Value: p.cur.Literal}

	if p.peek.Type == token.TOKEN_COLON {
		p.nextToken() // cur: :
		stmt.DataType = p.parseTypeAnnotation()
		if stmt.DataType == "" {
			p.errors = append(p.errors, fmt.Sprintf("[行:%d, 列:%d] 期望类型关键字或标识符，得到: %s (%s)",
				p.peek.Line, p.peek.Column, p.peek.Type, p.peek.Literal))
			return nil
		}
	}

	if p.peek.Type == token.TOKEN_ASSIGN {
		p.nextToken() // cur: =
		p.nextToken() // cur: start of expression
		stmt.Value = p.parseExpression(LOWEST)
	}

	return stmt
}

func (p *Parser) parseAssignStatement() *ast.AssignStatement {
	stmt := &ast.AssignStatement{Token: p.cur, Name: p.cur.Literal}
	p.nextToken() // cur: =, peek: value
	p.nextToken() // cur: value
	stmt.Value = p.parseExpression(LOWEST)
	return stmt
}

func (p *Parser) parseIfStatement() *ast.IfStatement {
	stmt := &ast.IfStatement{Token: p.cur}
	p.nextToken() // cur: condition

	// 条件表达式不允许使用 '='
	cond := p.parseExpression(LOWEST)
	if p.isAssignmentExpression(cond) {
		p.errors = append(p.errors, fmt.Sprintf("[行:%d] 条件表达式中不允许使用 '=' 赋值，请使用 '==' 或 '等于'", stmt.GetLine()))
		return nil
	}
	stmt.Condition = cond

	if !p.expectPeek(token.TOKEN_LBRACE) {
		return nil
	}
	stmt.ThenBlock = p.parseBlock()

	for p.peek.Type == token.TOKEN_ELSE_IF {
		p.nextToken() // cur: 抑
		p.nextToken() // cur: condition
		cond := p.parseExpression(LOWEST)
		if p.isAssignmentExpression(cond) {
			p.errors = append(p.errors, fmt.Sprintf("[行:%d] 条件表达式中不允许使用 '=' 赋值，请使用 '==' 或 '等于'", p.cur.Line))
			return nil
		}
		eif := &ast.ElseIfBranch{
			Condition: cond,
		}
		if !p.expectPeek(token.TOKEN_LBRACE) {
			return nil
		}
		eif.Block = p.parseBlock()
		stmt.ElseIfs = append(stmt.ElseIfs, eif)
	}

	if p.peek.Type == token.TOKEN_ELSE {
		p.nextToken() // cur: 否
		if !p.expectPeek(token.TOKEN_LBRACE) {
			return nil
		}
		stmt.ElseBlock = p.parseBlock()
	}
	return stmt
}

func (p *Parser) isAssignmentExpression(exp ast.Expression) bool {
	// 检查是否是赋值表达式。在我们的 AST 中，AssignStatement 是 Statement 不是 Expression。
	// 但如果是 Identifier = Expression，Lexer 会将其解析为 InfixExpression (Operator: "=") 如果我们没特殊处理。
	// 让我们检查 InfixExpression
	if infix, ok := exp.(*ast.InfixExpression); ok {
		return infix.Operator == "="
	}
	return false
}

func (p *Parser) parseWhileStatement() *ast.WhileStatement {
	stmt := &ast.WhileStatement{Token: p.cur}
	p.nextToken() // cur: condition
	cond := p.parseExpression(LOWEST)
	if p.isAssignmentExpression(cond) {
		p.errors = append(p.errors, fmt.Sprintf("[行:%d] 条件表达式中不允许使用 '=' 赋值，请使用 '==' 或 '等于'", stmt.GetLine()))
		return nil
	}
	stmt.Condition = cond

	if !p.expectPeek(token.TOKEN_LBRACE) {
		return nil
	}
	stmt.Block = p.parseBlock()
	return stmt
}

func (p *Parser) parseMatchStatement() *ast.MatchStatement {
	stmt := &ast.MatchStatement{Token: p.cur}

	p.nextToken() // match value
	stmt.Value = p.parseExpression(LOWEST)

	if !p.expectPeek(token.TOKEN_LBRACE) {
		return nil
	}

	for p.peek.Type != token.TOKEN_RBRACE && p.peek.Type != token.TOKEN_EOF {
		p.nextToken()
		caseNode := p.parseMatchCase()
		if caseNode != nil {
			stmt.Cases = append(stmt.Cases, caseNode)
		}
	}

	if !p.expectPeek(token.TOKEN_RBRACE) {
		return nil
	}

	return stmt
}

func (p *Parser) parseMatchCase() *ast.MatchCase {
	mc := &ast.MatchCase{}

	// Pattern can be a literal, or '是 类型'
	mc.Pattern = p.parseExpression(LOWEST)

	if !p.expectPeek(token.TOKEN_ARROW) {
		return nil
	}
	mc.Token = p.cur

	if !p.expectPeek(token.TOKEN_LBRACE) {
		return nil
	}

	mc.Body = p.parseBlock()
	return mc
}

func (p *Parser) parseLoopStatement() *ast.LoopStatement {
	stmt := &ast.LoopStatement{Token: p.cur}
	if !p.expectPeek(token.TOKEN_LBRACE) {
		return nil
	}
	stmt.Block = p.parseBlock()
	return stmt
}

func (p *Parser) parseForStatement() *ast.ForStatement {
	stmt := &ast.ForStatement{Token: p.cur}

	if !p.expectPeek(token.TOKEN_IDENT) {
		return nil
	}
	stmt.Variable = &ast.Identifier{Token: p.cur, Value: p.cur.Literal}

	if !p.expectPeek(token.TOKEN_IN) {
		return nil
	}

	p.nextToken() // skip 于
	stmt.Iterable = p.parseExpression(LOWEST)

	if !p.expectPeek(token.TOKEN_LBRACE) {
		return nil
	}
	stmt.Block = p.parseBlock()

	return stmt
}

func (p *Parser) parseInterfaceStatement(visibility token.TokenType) *ast.InterfaceStatement {
	stmt := &ast.InterfaceStatement{Token: p.cur, Visibility: visibility}

	if !p.expectPeek(token.TOKEN_IDENT) {
		return nil
	}

	stmt.Name = &ast.Identifier{Token: p.cur, Value: p.cur.Literal}

	if !p.expectPeek(token.TOKEN_LBRACE) {
		return nil
	}

	for p.peek.Type != token.TOKEN_RBRACE && p.peek.Type != token.TOKEN_EOF {
		p.nextToken()
		if p.cur.Type == token.TOKEN_FUNCTION {
			if !p.expectPeek(token.TOKEN_IDENT) {
				return nil
			}
			method := &ast.MethodSignature{Name: &ast.Identifier{Token: p.cur, Value: p.cur.Literal}}
			if !p.expectPeek(token.TOKEN_LPAREN) {
				return nil
			}
			method.Parameters = p.parseFunctionParameters()
			if p.peek.Type == token.TOKEN_COLON {
				p.nextToken()
				method.ReturnType = p.parseTypeAnnotation()
			}
			stmt.Methods = append(stmt.Methods, method)
		} else {
			p.errors = append(p.errors, fmt.Sprintf("[行:%d] 接口内部仅支持方法签名定义，得到: %s", p.cur.Line, p.cur.Type))
			return nil
		}
	}

	if !p.expectPeek(token.TOKEN_RBRACE) {
		return nil
	}

	return stmt
}

func (p *Parser) parseTryCatchStatement() *ast.TryCatchStatement {
	stmt := &ast.TryCatchStatement{Token: p.cur}
	if !p.expectPeek(token.TOKEN_LBRACE) {
		return nil
	}
	stmt.TryBlock = p.parseBlock()

	if !p.expectPeek(token.TOKEN_CATCH) {
		return nil
	}
	stmt.CatchToken = p.cur

	if !p.expectPeek(token.TOKEN_LPAREN) {
		return nil
	}
	if !p.expectPeek(token.TOKEN_IDENT) {
		return nil
	}
	stmt.CatchVar = &ast.Identifier{Token: p.cur, Value: p.cur.Literal}
	if !p.expectPeek(token.TOKEN_RPAREN) {
		return nil
	}

	if !p.expectPeek(token.TOKEN_LBRACE) {
		return nil
	}
	stmt.CatchBlock = p.parseBlock()
	return stmt
}

func (p *Parser) parseAsyncExpression() *ast.AsyncExpression {
	exp := &ast.AsyncExpression{Token: p.cur}
	if p.peek.Type == token.TOKEN_LBRACE {
		p.nextToken()
		exp.Block = p.parseBlock()
	} else {
		p.nextToken()
		exp.Block = []ast.Statement{p.parseStatement()}
	}
	return exp
}

func (p *Parser) parseParallelExpression() *ast.ParallelExpression {
	exp := &ast.ParallelExpression{Token: p.cur}
	if !p.expectPeek(token.TOKEN_LBRACE) {
		return nil
	}
	p.nextToken() // skip {
	for p.cur.Type != token.TOKEN_RBRACE && p.cur.Type != token.TOKEN_EOF {
		if p.cur.Type == token.TOKEN_LBRACE {
			exp.Blocks = append(exp.Blocks, p.parseBlock())
		} else {
			exp.Blocks = append(exp.Blocks, []ast.Statement{p.parseStatement()})
		}
		if p.peek.Type == token.TOKEN_COMMA {
			p.nextToken()
		}
		p.nextToken()
	}
	return exp
}

func (p *Parser) parseBlock() []ast.Statement {
	statements := []ast.Statement{}
	p.nextToken() // skip {
	for p.cur.Type != token.TOKEN_RBRACE && p.cur.Type != token.TOKEN_EOF {
		stmt := p.parseStatement()
		if stmt != nil {
			statements = append(statements, stmt)
		}
		p.nextToken()
	}
	return statements
}

func (p *Parser) parseExpressionStatement() ast.Statement {
	exp := p.parseExpression(LOWEST)

	// 处理成员赋值 (obj.member = value)
	if mce, ok := exp.(*ast.MemberCallExpression); ok && p.peek.Type == token.TOKEN_ASSIGN {
		stmt := &ast.MemberAssignStatement{
			Token:  p.peek,
			Object: mce.Object,
			Member: mce.Member,
		}
		p.nextToken() // cur: =
		p.nextToken() // cur: start of expression
		stmt.Value = p.parseExpression(LOWEST)
		return stmt
	}

	return &ast.ExpressionStatement{Token: p.cur, Expression: exp}
}

func (p *Parser) parseExpression(precedence int) ast.Expression {
	var leftExp ast.Expression

	switch p.cur.Type {
	case token.TOKEN_IDENT:
		leftExp = &ast.Identifier{Token: p.cur, Value: p.cur.Literal}
	case token.TOKEN_STRING_TYPE, token.TOKEN_INT_TYPE, token.TOKEN_FLOAT_TYPE, token.TOKEN_BOOL_TYPE, token.TOKEN_ARRAY_TYPE, token.TOKEN_DICT_TYPE:
		leftExp = &ast.Identifier{Token: p.cur, Value: p.cur.Literal}
	case token.TOKEN_NUMBER:
		leftExp = p.parseIntegerLiteral()
	case token.TOKEN_FLOAT:
		leftExp = p.parseFloatLiteral()
	case token.TOKEN_STRING:
		leftExp = p.parseStringLiteral()
	case token.TOKEN_TRUE, token.TOKEN_FALSE:
		leftExp = &ast.BooleanLiteral{Token: p.cur, Value: p.cur.Type == token.TOKEN_TRUE}
	case token.TOKEN_NULL:
		leftExp = &ast.Identifier{Token: p.cur, Value: "空"}
	case token.TOKEN_THIS:
		leftExp = &ast.Identifier{Token: p.cur, Value: "此"}
	case token.TOKEN_FUNCTION:
		leftExp = p.parseFunctionLiteral()
	case token.TOKEN_ASYNC:
		leftExp = p.parseAsyncExpression()
	case token.TOKEN_PARALLEL:
		leftExp = p.parseParallelExpression()
	case token.TOKEN_AWAIT:
		leftExp = p.parseAwaitExpression()
	case token.TOKEN_IMPORT:
		leftExp = p.parseImportExpression()
	case token.TOKEN_NEW:
		leftExp = p.parseNewExpression()
	case token.TOKEN_SERIALIZE:
		leftExp = p.parseSerializeExpression()
	case token.TOKEN_DESERIALIZE:
		leftExp = p.parseDeserializeExpression()
	case token.TOKEN_CONNECT:
		leftExp = p.parseConnectExpression()
	case token.TOKEN_LISTEN:
		leftExp = p.parseListenExpression()
	case token.TOKEN_REQUEST:
		leftExp = p.parseConnectRequestExpression()
	case token.TOKEN_EXECUTE:
		leftExp = p.parseExecuteExpression()
	case token.TOKEN_CHANNEL:
		leftExp = &ast.ChannelExpression{Token: p.cur}
	case token.TOKEN_SUCCESS, token.TOKEN_FAILURE:
		leftExp = p.parseResultLiteral()
	case token.TOKEN_NOT, token.TOKEN_MINUS, token.TOKEN_IS:
		leftExp = p.parsePrefixExpression()
	case token.TOKEN_LBRACKET:
		leftExp = p.parseArrayLiteral()
	case token.TOKEN_LBRACE:
		leftExp = p.parseDictLiteral()
	case token.TOKEN_LPAREN:
		p.nextToken()
		leftExp = p.parseExpression(LOWEST)
		if !p.expectPeek(token.TOKEN_RPAREN) {
			return nil
		}
	default:
		p.errors = append(p.errors, fmt.Sprintf("[行:%d, 列:%d] 无法解析的 Token 类型: %s (%s)",
			p.cur.Line, p.cur.Column, p.cur.Type, p.cur.Literal))
		return nil
	}

	for p.peek.Type != token.TOKEN_EOF && precedence < p.peekPrecedence() {
		switch p.peek.Type {
		case token.TOKEN_PLUS, token.TOKEN_MINUS, token.TOKEN_MUL, token.TOKEN_DIV, token.TOKEN_MOD,
			token.TOKEN_EQ, token.TOKEN_NEQ, token.TOKEN_ASSIGN, token.TOKEN_AMPERSAND,
			token.TOKEN_AND, token.TOKEN_OR, token.TOKEN_IS,
			token.TOKEN_LE, token.TOKEN_GE:
			p.nextToken()
			leftExp = p.parseInfixExpression(leftExp)
		case token.TOKEN_LT:
			// 只有在没有空格的情况下才解析为泛型调用 f<T>(...)
			if !p.peek.HasSpaceBefore {
				p.nextToken() // cur: <
				typeArgs := p.parseTypeArgumentList()
				if p.peek.Type == token.TOKEN_LPAREN {
					p.nextToken()
					leftExp = &ast.CallExpression{
						Token:         p.cur,
						Function:      leftExp,
						TypeArguments: typeArgs,
						Arguments:     p.parseCallArguments(),
					}
				} else {
					// 即使没空格，如果没有 ( 也可能是 a < b
					// 由于已经消耗了 <，我们需要尝试恢复。
					// 如果 typeArgs 为空，说明 < 后面不是有效的类型名，肯定是比较。
					var right ast.Expression
					if len(typeArgs) > 0 {
						right = &ast.Identifier{Token: token.Token{Type: token.TOKEN_IDENT, Literal: typeArgs[0]}, Value: typeArgs[0]}
					} else {
						right = p.parseExpression(LESSGREATER)
					}
					leftExp = &ast.InfixExpression{
						Token:    token.Token{Type: token.TOKEN_LT, Literal: "<", Line: p.cur.Line, Column: p.cur.Column},
						Left:     leftExp,
						Operator: "<",
						Right:    right,
					}
				}
			} else {
				p.nextToken()
				leftExp = p.parseInfixExpression(leftExp)
			}
		case token.TOKEN_GT:
			p.nextToken()
			leftExp = p.parseInfixExpression(leftExp)
		case token.TOKEN_DOT:
			p.nextToken()
			leftExp = p.parseMemberCallExpression(leftExp)
		case token.TOKEN_LPAREN:
			p.nextToken()
			leftExp = p.parseCallExpression(leftExp)
		case token.TOKEN_LBRACKET:
			p.nextToken()
			leftExp = p.parseIndexExpression(leftExp)
		default:
			return leftExp
		}
	}

	return leftExp
}

func (p *Parser) parseStringLiteral() ast.Expression {
	lit := &ast.StringLiteral{Token: p.cur, Value: p.cur.Literal}
	if !strings.Contains(lit.Value, "${") {
		return lit
	}

	var expressions []ast.Expression
	str := lit.Value
	for {
		start := strings.Index(str, "${")
		if start == -1 {
			if str != "" {
				expressions = append(expressions, &ast.StringLiteral{Token: p.cur, Value: str})
			}
			break
		}

		if start > 0 {
			expressions = append(expressions, &ast.StringLiteral{Token: p.cur, Value: str[:start]})
		}

		str = str[start+2:]

		// 寻找匹配的 }
		depth := 1
		end := -1
		for i := 0; i < len(str); i++ {
			char := str[i]
			if char == '{' {
				depth++
			} else if char == '}' {
				depth--
				if depth == 0 {
					end = i
					break
				}
			}
		}

		if end == -1 {
			p.errors = append(p.errors, fmt.Sprintf("[行:%d] 字符串插值未闭合", p.cur.Line))
			return lit
		}

		exprStr := str[:end]
		subLexer := lexer.New(exprStr)
		subParser := New(subLexer)
		subExpr := subParser.parseExpression(LOWEST)
		if subExpr != nil {
			// 递归设置所有子节点的行号和列号，确保在错误信息中正确显示
			ast.Walk(subExpr, func(node ast.Node) {
				if node != nil {
					// 尝试设置所有类型的行号
					switch n := node.(type) {
					case *ast.Identifier:
						n.Token.Line = p.cur.Line
						n.Token.Column = p.cur.Column + start + 2
					case *ast.IntegerLiteral:
						n.Token.Line = p.cur.Line
						n.Token.Column = p.cur.Column + start + 2
					case *ast.FloatLiteral:
						n.Token.Line = p.cur.Line
						n.Token.Column = p.cur.Column + start + 2
					case *ast.StringLiteral:
						n.Token.Line = p.cur.Line
						n.Token.Column = p.cur.Column + start + 2
					case *ast.BooleanLiteral:
						n.Token.Line = p.cur.Line
						n.Token.Column = p.cur.Column + start + 2
					case *ast.InfixExpression:
						n.Token.Line = p.cur.Line
						n.Token.Column = p.cur.Column + start + 2
					case *ast.CallExpression:
						n.Token.Line = p.cur.Line
						n.Token.Column = p.cur.Column + start + 2
					case *ast.MemberCallExpression:
						n.Token.Line = p.cur.Line
						n.Token.Column = p.cur.Column + start + 2
					case *ast.PrefixExpression:
						n.Token.Line = p.cur.Line
						n.Token.Column = p.cur.Column + start + 2
					case *ast.ArrayLiteral:
						n.Token.Line = p.cur.Line
						n.Token.Column = p.cur.Column + start + 2
					case *ast.DictLiteral:
						n.Token.Line = p.cur.Line
						n.Token.Column = p.cur.Column + start + 2
					case *ast.IndexExpression:
						n.Token.Line = p.cur.Line
						n.Token.Column = p.cur.Column + start + 2
					}
				}
			})
			expressions = append(expressions, subExpr)
		}

		str = str[end+1:]
	}

	if len(expressions) == 0 {
		return lit
	}
	if len(expressions) == 1 {
		return expressions[0]
	}

	res := &ast.InfixExpression{
		Token:    token.Token{Type: token.TOKEN_AMPERSAND, Literal: "&", Line: p.cur.Line},
		Left:     expressions[0],
		Operator: "&",
		Right:    expressions[1],
	}

	for i := 2; i < len(expressions); i++ {
		res = &ast.InfixExpression{
			Token:    token.Token{Type: token.TOKEN_AMPERSAND, Literal: "&", Line: p.cur.Line},
			Left:     res,
			Operator: "&",
			Right:    expressions[i],
		}
	}

	return res
}

func (p *Parser) parseIntegerLiteral() ast.Expression {
	val, err := strconv.ParseInt(p.cur.Literal, 0, 64)
	if err != nil {
		p.errors = append(p.errors, fmt.Sprintf("无法解析整数: %s", p.cur.Literal))
		return nil
	}
	return &ast.IntegerLiteral{Token: p.cur, Value: val}
}

func (p *Parser) parseFloatLiteral() ast.Expression {
	val, err := strconv.ParseFloat(p.cur.Literal, 64)
	if err != nil {
		p.errors = append(p.errors, fmt.Sprintf("无法解析小数: %s", p.cur.Literal))
		return nil
	}
	return &ast.FloatLiteral{Token: p.cur, Value: val}
}

func (p *Parser) parseIndexExpression(left ast.Expression) ast.Expression {
	exp := &ast.IndexExpression{Token: p.cur, Left: left}

	p.nextToken()
	exp.Index = p.parseExpression(LOWEST)

	if !p.expectPeek(token.TOKEN_RBRACKET) {
		return nil
	}

	return exp
}

func (p *Parser) parsePrefixExpression() ast.Expression {
	exp := &ast.PrefixExpression{
		Token:    p.cur,
		Operator: p.cur.Literal,
	}
	p.nextToken()
	exp.Right = p.parseExpression(PRODUCT) // 给予前缀运算符高优先级
	return exp
}

func (p *Parser) parseInfixExpression(left ast.Expression) ast.Expression {
	exp := &ast.InfixExpression{
		Token:    p.cur,
		Operator: p.cur.Literal,
		Left:     left,
	}
	precedence := p.curPrecedence()
	p.nextToken()
	exp.Right = p.parseExpression(precedence)
	return exp
}

func (p *Parser) parseTypeDefinitionStatement(visibility token.TokenType) *ast.TypeDefinitionStatement {
	stmt := &ast.TypeDefinitionStatement{Token: p.cur, Visibility: visibility}

	if !p.expectPeek(token.TOKEN_IDENT) {
		return nil
	}

	stmt.Name = &ast.Identifier{Token: p.cur, Value: p.cur.Literal}

	// 检查泛型参数 <T, U>
	if p.peek.Type == token.TOKEN_LT {
		p.nextToken() // cur: <
		stmt.GenericParams = p.parseGenericParamList()
	}

	// 检查是否有 "承" (继承)
	if p.peek.Type == token.TOKEN_INHERIT {
		p.nextToken() // cur: 承
		if !p.expectPeek(token.TOKEN_IDENT) {
			return nil
		}
		stmt.Parent = &ast.Identifier{Token: p.cur, Value: p.cur.Literal}
	}

	if !p.expectPeek(token.TOKEN_LBRACE) {
		return nil
	}

	stmt.Block = p.parseBlock()

	return stmt
}

func (p *Parser) parseFunctionStatement(visibility token.TokenType) *ast.FunctionStatement {
	stmt := &ast.FunctionStatement{Token: p.cur, Visibility: visibility}
	p.nextToken() // skip 函

	if p.cur.Type != token.TOKEN_IDENT && p.cur.Type != token.TOKEN_NEW {
		p.errors = append(p.errors, fmt.Sprintf("预期函数名，得到 %s", p.cur.Type))
		return nil
	}

	stmt.Name = &ast.Identifier{Token: p.cur, Value: p.cur.Literal}

	// 检查泛型参数 <T, U>
	if p.peek.Type == token.TOKEN_LT {
		p.nextToken() // cur: <
		stmt.GenericParams = p.parseGenericParamList()
	}

	if !p.expectPeek(token.TOKEN_LPAREN) {
		return nil
	}

	stmt.Parameters = p.parseFunctionParameters()

	// 检查返回类型
	if p.peek.Type == token.TOKEN_COLON {
		p.nextToken() // cur: :
		stmt.ReturnType = p.parseTypeAnnotation()
	}

	if !p.expectPeek(token.TOKEN_LBRACE) {
		return nil
	}

	stmt.Body = p.parseBlock()

	return stmt
}

func (p *Parser) parseNewExpression() ast.Expression {
	exp := &ast.NewExpression{Token: p.cur}
	p.nextToken() // cur: type identifier

	// 限制类型部分只解析标识符或成员访问，不解析调用
	// 我们先解析第一个标识符
	exp.Type = p.parseExpression(DOT)

	// 手动解析后续的成员访问，以避免 parseMemberCallExpression 吞掉括号
	for p.peek.Type == token.TOKEN_DOT {
		p.nextToken() // cur: .
		if !p.expectPeek(token.TOKEN_IDENT) {
			return nil
		}
		exp.Type = &ast.MemberCallExpression{
			Token:  p.cur,
			Object: exp.Type,
			Member: &ast.Identifier{Token: p.cur, Value: p.cur.Literal},
		}
	}

	// 检查泛型实际类型 <整>
	if p.peek.Type == token.TOKEN_LT {
		p.nextToken() // cur: <
		exp.TypeArguments = p.parseTypeArgumentList()
	}

	if p.peek.Type == token.TOKEN_LBRACE {
		p.nextToken() // cur: {
		exp.Data = p.parseDictLiteral()
	} else if p.peek.Type == token.TOKEN_LPAREN {
		p.nextToken() // cur: (
		exp.Arguments = p.parseCallArguments()
	}

	return exp
}

func (p *Parser) parseSerializeExpression() ast.Expression {
	exp := &ast.SerializeExpression{Token: p.cur}
	if !p.expectPeek(token.TOKEN_LPAREN) {
		return nil
	}
	p.nextToken()
	exp.Value = p.parseExpression(LOWEST)
	if !p.expectPeek(token.TOKEN_RPAREN) {
		return nil
	}
	return exp
}

func (p *Parser) parseDeserializeExpression() ast.Expression {
	exp := &ast.DeserializeExpression{Token: p.cur}
	if !p.expectPeek(token.TOKEN_LPAREN) {
		return nil
	}
	p.nextToken()
	exp.Value = p.parseExpression(LOWEST)
	if !p.expectPeek(token.TOKEN_RPAREN) {
		return nil
	}
	return exp
}

func (p *Parser) parseConnectExpression() ast.Expression {
	exp := &ast.ConnectExpression{Token: p.cur}
	if !p.expectPeek(token.TOKEN_LPAREN) {
		return nil
	}
	p.nextToken()
	exp.Address = p.parseExpression(LOWEST)
	if p.peek.Type == token.TOKEN_COMMA {
		p.nextToken()
		p.nextToken()
		exp.Arguments = p.parseCallArguments()
	}
	if !p.expectPeek(token.TOKEN_RPAREN) {
		return nil
	}
	return exp
}

func (p *Parser) parseListenExpression() ast.Expression {
	exp := &ast.ListenExpression{Token: p.cur}
	if !p.expectPeek(token.TOKEN_LPAREN) {
		return nil
	}
	p.nextToken()
	exp.Address = p.parseExpression(LOWEST)
	if !p.expectPeek(token.TOKEN_COMMA) {
		return nil
	}
	p.nextToken()
	exp.Callback = p.parseExpression(LOWEST)
	if p.peek.Type == token.TOKEN_COMMA {
		p.nextToken()
		p.nextToken()
		exp.Arguments = p.parseCallArguments()
	}
	if !p.expectPeek(token.TOKEN_RPAREN) {
		return nil
	}
	return exp
}

func (p *Parser) parseConnectRequestExpression() ast.Expression {
	exp := &ast.ConnectRequestExpression{Token: p.cur}
	if !p.expectPeek(token.TOKEN_LPAREN) {
		return nil
	}
	p.nextToken()
	exp.Url = p.parseExpression(LOWEST)
	if p.peek.Type == token.TOKEN_COMMA {
		p.nextToken()
		p.nextToken()
		exp.Arguments = p.parseCallArguments()
	}
	if !p.expectPeek(token.TOKEN_RPAREN) {
		return nil
	}
	return exp
}

func (p *Parser) parseExecuteExpression() ast.Expression {
	exp := &ast.ExecuteExpression{Token: p.cur}
	if !p.expectPeek(token.TOKEN_LPAREN) {
		return nil
	}
	p.nextToken()
	exp.Command = p.parseExpression(LOWEST)
	if !p.expectPeek(token.TOKEN_RPAREN) {
		return nil
	}
	return exp
}

func (p *Parser) parseFunctionLiteral() ast.Expression {
	lit := &ast.FunctionLiteral{Token: p.cur}

	// 检查泛型参数 <T, U>
	if p.peek.Type == token.TOKEN_LT {
		p.nextToken() // cur: <
		lit.GenericParams = p.parseGenericParamList()
	}

	if !p.expectPeek(token.TOKEN_LPAREN) {
		return nil
	}

	lit.Parameters = p.parseFunctionParameters()

	// 检查返回类型
	if p.peek.Type == token.TOKEN_COLON {
		p.nextToken() // cur: :
		lit.ReturnType = p.parseTypeAnnotation()
	}

	if !p.expectPeek(token.TOKEN_LBRACE) {
		return nil
	}

	lit.Body = p.parseBlock()

	return lit
}

func (p *Parser) parseArrayLiteral() ast.Expression {
	array := &ast.ArrayLiteral{Token: p.cur}
	array.Elements = p.parseExpressionList(token.TOKEN_RBRACKET)
	return array
}

func (p *Parser) parseExpressionList(end token.TokenType) []ast.Expression {
	list := []ast.Expression{}

	if p.peek.Type == end {
		p.nextToken()
		return list
	}

	p.nextToken()
	list = append(list, p.parseExpression(LOWEST))

	for p.peek.Type == token.TOKEN_COMMA {
		p.nextToken()
		p.nextToken()
		list = append(list, p.parseExpression(LOWEST))
	}

	if !p.expectPeek(end) {
		return nil
	}

	return list
}

func (p *Parser) parseDictLiteral() ast.Expression {
	dict := &ast.DictLiteral{Token: p.cur}
	dict.Pairs = make(map[ast.Expression]ast.Expression)

	for p.peek.Type != token.TOKEN_RBRACE {
		p.nextToken()
		key := p.parseExpression(LOWEST)

		if !p.expectPeek(token.TOKEN_COLON) {
			return nil
		}

		p.nextToken()
		value := p.parseExpression(LOWEST)

		dict.Pairs[key] = value

		if p.peek.Type != token.TOKEN_RBRACE && !p.expectPeek(token.TOKEN_COMMA) {
			return nil
		}
	}

	if !p.expectPeek(token.TOKEN_RBRACE) {
		return nil
	}

	return dict
}

func (p *Parser) parseFunctionParameters() []*ast.Parameter {
	parameters := []*ast.Parameter{}

	if p.peek.Type == token.TOKEN_RPAREN {
		p.nextToken()
		return parameters
	}

	p.nextToken()

	param := &ast.Parameter{Name: &ast.Identifier{Token: p.cur, Value: p.cur.Literal}}
	if p.peek.Type == token.TOKEN_COLON {
		p.nextToken() // cur: :
		param.DataType = p.parseTypeAnnotation()
	}
	parameters = append(parameters, param)

	for p.peek.Type == token.TOKEN_COMMA {
		p.nextToken()
		p.nextToken()
		param := &ast.Parameter{Name: &ast.Identifier{Token: p.cur, Value: p.cur.Literal}}
		if p.peek.Type == token.TOKEN_COLON {
			p.nextToken() // cur: :
			param.DataType = p.parseTypeAnnotation()
		}
		parameters = append(parameters, param)
	}

	if !p.expectPeek(token.TOKEN_RPAREN) {
		return nil
	}

	return parameters
}

func (p *Parser) parseCallExpression(function ast.Expression) ast.Expression {
	exp := &ast.CallExpression{Token: p.cur, Function: function}

	// 检查泛型实际类型 <整>
	if p.cur.Type == token.TOKEN_LT {
		exp.TypeArguments = p.parseTypeArgumentList()
		if !p.expectPeek(token.TOKEN_LPAREN) {
			return nil
		}
	}

	exp.Arguments = p.parseCallArguments()
	return exp
}

func (p *Parser) parseMemberCallExpression(left ast.Expression) ast.Expression {
	exp := &ast.MemberCallExpression{Token: p.cur, Object: left}

	if !p.isMemberName(p.peek.Type) {
		p.errors = append(p.errors, "预期下一个 Token 为成员名，但实际得到 "+string(p.peek.Type))
		return nil
	}
	p.nextToken()

	exp.Member = &ast.Identifier{Token: p.cur, Value: p.cur.Literal}

	if p.peek.Type == token.TOKEN_LPAREN {
		p.nextToken()
		exp.Arguments = p.parseCallArguments()
	}

	return exp
}

func (p *Parser) isMemberName(t token.TokenType) bool {
	switch t {
	case token.TOKEN_IDENT, token.TOKEN_THEN, token.TOKEN_ELSE, token.TOKEN_FUNCTION,
		token.TOKEN_INT_TYPE, token.TOKEN_STRING_TYPE, token.TOKEN_BOOL_TYPE, token.TOKEN_FLOAT_TYPE,
		token.TOKEN_SUCCESS, token.TOKEN_FAILURE:
		return true
	default:
		return false
	}
}

func (p *Parser) parseAwaitExpression() ast.Expression {
	exp := &ast.AwaitExpression{Token: p.cur}
	if !p.expectPeek(token.TOKEN_LPAREN) {
		return nil
	}
	p.nextToken()
	exp.Value = p.parseExpression(LOWEST)
	if !p.expectPeek(token.TOKEN_RPAREN) {
		return nil
	}
	return exp
}

func (p *Parser) parseResultLiteral() ast.Expression {
	// 成功(val) 或 失败(err) 实际上会被解析为类似 CallExpression
	// 但为了方便后续处理，我们可以直接复用 CallExpression 的逻辑，
	// 或者在 Evaluator 中特殊处理这两个关键字。
	// 这里简单处理：把它当成一个特殊的标识符调用。
	ident := &ast.Identifier{Token: p.cur, Value: p.cur.Literal}
	if !p.expectPeek(token.TOKEN_LPAREN) {
		return nil
	}
	return p.parseCallExpression(ident)
}

func (p *Parser) parseCallArguments() []ast.Expression {
	args := []ast.Expression{}

	if p.peek.Type == token.TOKEN_RPAREN {
		p.nextToken()
		return args
	}

	p.nextToken()
	args = append(args, p.parseExpression(LOWEST))

	for p.peek.Type == token.TOKEN_COMMA {
		p.nextToken()
		p.nextToken()
		args = append(args, p.parseExpression(LOWEST))
	}

	if !p.expectPeek(token.TOKEN_RPAREN) {
		return nil
	}

	return args
}

func (p *Parser) expectPeek(t token.TokenType) bool {
	if p.peek.Type == t {
		p.nextToken()
		return true
	}
	p.errors = append(p.errors, fmt.Sprintf("[行:%d, 列:%d] 预期下一个 Token 为 %s，但实际得到 %s (%s)",
		p.peek.Line, p.peek.Column, t, p.peek.Type, p.peek.Literal))
	return false
}

func (p *Parser) peekPrecedence() int {
	if p, ok := precedences[p.peek.Type]; ok {
		return p
	}
	return LOWEST
}

func (p *Parser) curPrecedence() int {
	if p, ok := precedences[p.cur.Type]; ok {
		return p
	}
	return LOWEST
}

func (p *Parser) isTypeToken(t token.TokenType) bool {
	return t == token.TOKEN_STRING_TYPE || t == token.TOKEN_INT_TYPE ||
		t == token.TOKEN_FLOAT_TYPE || t == token.TOKEN_BOOL_TYPE ||
		t == token.TOKEN_ARRAY_TYPE || t == token.TOKEN_DICT_TYPE ||
		t == token.TOKEN_BYTES_TYPE || t == token.TOKEN_RESULT_TYPE ||
		t == token.TOKEN_IDENT || t == token.TOKEN_NULL
}

func (p *Parser) parseTypeAnnotation() string {
	if !p.isTypeToken(p.peek.Type) {
		return ""
	}
	p.nextToken() // move to first type part

	typeStr := p.cur.Literal

	// Handle Generic Arguments: 类型<实际类型>
	if p.peek.Type == token.TOKEN_LT {
		p.nextToken() // cur: <
		typeStr += "<"
		if p.peek.Type != token.TOKEN_GT {
			typeStr += p.parseTypeAnnotation()
			for p.peek.Type == token.TOKEN_COMMA {
				p.nextToken() // cur: ,
				typeStr += ", "
				typeStr += p.parseTypeAnnotation()
			}
		}
		if !p.expectPeek(token.TOKEN_GT) {
			return typeStr
		}
		typeStr += ">"
	}

	// Handle Nullable Type: 类型?
	if p.peek.Type == token.TOKEN_QUESTION {
		p.nextToken()
		typeStr += "?"
	}

	// Handle Union Type: 类型1 | 类型2
	for p.peek.Type == token.TOKEN_PIPE {
		p.nextToken() // skip |
		typeStr += " | "
		typeStr += p.parseTypeAnnotation()
	}

	return typeStr
}

func (p *Parser) parseGenericParamList() []*ast.GenericParam {
	params := []*ast.GenericParam{}

	if p.peek.Type == token.TOKEN_GT {
		p.nextToken()
		return params
	}

	p.nextToken() // move to first param name
	param := &ast.GenericParam{Name: p.cur.Literal}
	if p.peek.Type == token.TOKEN_INHERIT {
		p.nextToken() // cur: 承
		param.Constraint = p.parseTypeAnnotation()
	}
	params = append(params, param)

	for p.peek.Type == token.TOKEN_COMMA {
		p.nextToken() // cur: ,
		if !p.expectPeek(token.TOKEN_IDENT) {
			return nil
		}
		param := &ast.GenericParam{Name: p.cur.Literal}
		if p.peek.Type == token.TOKEN_INHERIT {
			p.nextToken() // cur: 承
			param.Constraint = p.parseTypeAnnotation()
		}
		params = append(params, param)
	}

	if !p.expectPeek(token.TOKEN_GT) {
		return nil
	}

	return params
}

func (p *Parser) parseTypeArgumentList() []string {
	args := []string{}

	if p.peek.Type == token.TOKEN_GT {
		p.nextToken()
		return args
	}

	args = append(args, p.parseTypeAnnotation())

	for p.peek.Type == token.TOKEN_COMMA {
		p.nextToken()
		args = append(args, p.parseTypeAnnotation())
	}

	if !p.expectPeek(token.TOKEN_GT) {
		return nil
	}

	return args
}
