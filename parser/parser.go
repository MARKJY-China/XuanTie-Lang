package parser

import (
	"fmt"
	"strconv"
	"xuantie/ast"
	"xuantie/lexer"
	"xuantie/token"
)

const (
	LOWEST      = iota
	LOGICAL_OR  // 或
	LOGICAL_AND // 且
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
	token.TOKEN_PLUS:      SUM,
	token.TOKEN_MINUS:     SUM,
	token.TOKEN_MUL:       PRODUCT,
	token.TOKEN_DIV:       PRODUCT,
	token.TOKEN_AMPERSAND: SUM,
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
		return p.parseTypeDefinitionStatement()
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
		if p.peek.Type == token.TOKEN_STRING_TYPE || p.peek.Type == token.TOKEN_INT_TYPE ||
			p.peek.Type == token.TOKEN_FLOAT_TYPE || p.peek.Type == token.TOKEN_BOOL_TYPE ||
			p.peek.Type == token.TOKEN_ARRAY_TYPE || p.peek.Type == token.TOKEN_DICT_TYPE {
			p.nextToken() // cur: type
			stmt.DataType = p.cur.Literal
		} else {
			p.errors = append(p.errors, fmt.Sprintf("[行:%d, 列:%d] 期望类型关键字，得到: %s (%s)",
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
		leftExp = &ast.TypeLiteral{Token: p.cur, Value: p.cur.Literal}
	case token.TOKEN_NUMBER:
		leftExp = p.parseIntegerLiteral()
	case token.TOKEN_FLOAT:
		leftExp = p.parseFloatLiteral()
	case token.TOKEN_STRING:
		leftExp = &ast.StringLiteral{Token: p.cur, Value: p.cur.Literal}
	case token.TOKEN_TRUE, token.TOKEN_FALSE:
		leftExp = &ast.BooleanLiteral{Token: p.cur, Value: p.cur.Type == token.TOKEN_TRUE}
	case token.TOKEN_NULL:
		leftExp = &ast.Identifier{Token: p.cur, Value: "空"}
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
	case token.TOKEN_SUCCESS, token.TOKEN_FAILURE:
		leftExp = p.parseResultLiteral()
	case token.TOKEN_NOT, token.TOKEN_MINUS:
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
		case token.TOKEN_PLUS, token.TOKEN_MINUS, token.TOKEN_MUL, token.TOKEN_DIV, token.TOKEN_LT, token.TOKEN_GT, token.TOKEN_EQ, token.TOKEN_NEQ, token.TOKEN_ASSIGN, token.TOKEN_AMPERSAND, token.TOKEN_AND, token.TOKEN_OR, token.TOKEN_IS:
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

func (p *Parser) parseTypeDefinitionStatement() *ast.TypeDefinitionStatement {
	stmt := &ast.TypeDefinitionStatement{Token: p.cur}

	if !p.expectPeek(token.TOKEN_IDENT) {
		return nil
	}

	stmt.Name = &ast.Identifier{Token: p.cur, Value: p.cur.Literal}

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

	if !p.expectPeek(token.TOKEN_LPAREN) {
		return nil
	}

	stmt.Parameters = p.parseFunctionParameters()

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
	exp.Type = p.parseExpression(CALL)

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

func (p *Parser) parseFunctionLiteral() ast.Expression {
	lit := &ast.FunctionLiteral{Token: p.cur}

	if !p.expectPeek(token.TOKEN_LPAREN) {
		return nil
	}

	lit.Parameters = p.parseFunctionParameters()

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

func (p *Parser) parseFunctionParameters() []*ast.Identifier {
	identifiers := []*ast.Identifier{}

	if p.peek.Type == token.TOKEN_RPAREN {
		p.nextToken()
		return identifiers
	}

	p.nextToken()

	ident := &ast.Identifier{Token: p.cur, Value: p.cur.Literal}
	identifiers = append(identifiers, ident)

	for p.peek.Type == token.TOKEN_COMMA {
		p.nextToken()
		p.nextToken()
		ident := &ast.Identifier{Token: p.cur, Value: p.cur.Literal}
		identifiers = append(identifiers, ident)
	}

	if !p.expectPeek(token.TOKEN_RPAREN) {
		return nil
	}

	return identifiers
}

func (p *Parser) parseCallExpression(function ast.Expression) ast.Expression {
	exp := &ast.CallExpression{Token: p.cur, Function: function}
	exp.Arguments = p.parseCallArguments()
	return exp
}

func (p *Parser) parseMemberCallExpression(left ast.Expression) ast.Expression {
	exp := &ast.MemberCallExpression{Token: p.cur, Object: left}
	// 允许 接着, 否则 以及其他标识符作为成员名
	if p.peek.Type != token.TOKEN_IDENT && p.peek.Type != token.TOKEN_THEN && p.peek.Type != token.TOKEN_ELSE {
		p.errors = append(p.errors, fmt.Sprintf("预期下一个 Token 为成员名，但实际得到 %s", p.peek.Type))
		return nil
	}
	p.nextToken()
	exp.Member = &ast.Identifier{Token: p.cur, Value: p.cur.Literal}

	if p.peek.Type == token.TOKEN_LPAREN {
		p.nextToken() // cur: (
		exp.Arguments = p.parseCallArguments()
	}
	return exp
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
