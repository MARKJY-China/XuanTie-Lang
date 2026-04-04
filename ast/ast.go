package ast

import (
	"bytes"
	"strconv"
	"strings"
	"xuantie/token"
)

type Node interface {
	TokenLiteral() string
	GetLine() int
	String() string
}

type Statement interface {
	Node
	statementNode()
}

type Expression interface {
	Node
	expressionNode()
}

// Program 根节点
type Program struct {
	Statements []Statement
	FilePath   string // 源文件路径
}

func (p *Program) TokenLiteral() string {
	if len(p.Statements) > 0 {
		return p.Statements[0].TokenLiteral()
	}
	return ""
}
func (p *Program) GetLine() int {
	if len(p.Statements) > 0 {
		return p.Statements[0].GetLine()
	}
	return 0
}
func (p *Program) String() string {
	var out bytes.Buffer
	for _, s := range p.Statements {
		out.WriteString(s.String())
	}
	return out.String()
}

// PrintStatement 打印语句
type PrintStatement struct {
	Token token.Token // 可选项，方便调试
	Value Expression
}

func (ps *PrintStatement) statementNode()       {}
func (ps *PrintStatement) TokenLiteral() string { return ps.Token.Literal }
func (ps *PrintStatement) GetLine() int         { return ps.Token.Line }
func (ps *PrintStatement) String() string {
	var out bytes.Buffer
	out.WriteString("打印(")
	if ps.Value != nil {
		out.WriteString(ps.Value.String())
	}
	out.WriteString(")")
	return out.String()
}

// VarStatement 变量/常量声明语句
type VarStatement struct {
	Token     token.Token // TOKEN_VAR or TOKEN_CONST
	Name      *Identifier
	DataType  string // 可选类型
	Value     Expression
	IsPrivate bool // 是否为私有属性
}

func (vs *VarStatement) statementNode()       {}
func (vs *VarStatement) TokenLiteral() string { return vs.Token.Literal }
func (vs *VarStatement) GetLine() int         { return vs.Token.Line }
func (vs *VarStatement) String() string {
	var out bytes.Buffer
	out.WriteString(vs.Token.Literal + " ")
	out.WriteString(vs.Name.String())
	if vs.DataType != "" {
		out.WriteString(":" + vs.DataType)
	}
	if vs.Value != nil {
		out.WriteString(" = ")
		out.WriteString(vs.Value.String())
	}
	return out.String()
}

// AssignStatement 赋值语句
type AssignStatement struct {
	Token token.Token
	Name  string
	Value Expression
}

func (as *AssignStatement) statementNode()       {}
func (as *AssignStatement) TokenLiteral() string { return as.Token.Literal }
func (as *AssignStatement) GetLine() int         { return as.Token.Line }
func (as *AssignStatement) String() string {
	var out bytes.Buffer
	out.WriteString(as.Name)
	out.WriteString(" = ")
	if as.Value != nil {
		out.WriteString(as.Value.String())
	}
	return out.String()
}

// MemberAssignStatement 成员赋值语句 (obj.member = value)
type MemberAssignStatement struct {
	Token  token.Token // '='
	Object Expression  // The object being accessed (e.g., Identifier or Call)
	Member *Identifier // The field being assigned
	Value  Expression  // The new value
}

func (mas *MemberAssignStatement) statementNode()       {}
func (mas *MemberAssignStatement) TokenLiteral() string { return mas.Token.Literal }
func (mas *MemberAssignStatement) GetLine() int         { return mas.Token.Line }
func (mas *MemberAssignStatement) String() string {
	var out bytes.Buffer
	out.WriteString(mas.Object.String())
	out.WriteString(".")
	out.WriteString(mas.Member.String())
	out.WriteString(" = ")
	out.WriteString(mas.Value.String())
	return out.String()
}

// IfStatement 条件语句
type ElseIfBranch struct {
	Condition Expression
	Block     []Statement
}

type IfStatement struct {
	Token     token.Token
	Condition Expression
	ThenBlock []Statement
	ElseIfs   []*ElseIfBranch
	ElseBlock []Statement
}

func (is *IfStatement) statementNode()       {}
func (is *IfStatement) TokenLiteral() string { return is.Token.Literal }
func (is *IfStatement) GetLine() int         { return is.Token.Line }
func (is *IfStatement) String() string {
	var out bytes.Buffer
	out.WriteString("若 ")
	if is.Condition != nil {
		out.WriteString(is.Condition.String())
	}
	out.WriteString(" { ")
	for _, stmt := range is.ThenBlock {
		out.WriteString(stmt.String())
		out.WriteString(" ")
	}
	out.WriteString("}")

	for _, eif := range is.ElseIfs {
		out.WriteString(" 抑 ")
		out.WriteString(eif.Condition.String())
		out.WriteString(" { ")
		for _, stmt := range eif.Block {
			out.WriteString(stmt.String())
			out.WriteString(" ")
		}
		out.WriteString("}")
	}

	if len(is.ElseBlock) > 0 {
		out.WriteString(" 否 { ")
		for _, stmt := range is.ElseBlock {
			out.WriteString(stmt.String())
			out.WriteString(" ")
		}
		out.WriteString("}")
	}
	return out.String()
}

// LoopStatement 无限循环语句
type LoopStatement struct {
	Token token.Token // TOKEN_LOOP '循'
	Block []Statement
}

func (ls *LoopStatement) statementNode()       {}
func (ls *LoopStatement) TokenLiteral() string { return ls.Token.Literal }
func (ls *LoopStatement) GetLine() int         { return ls.Token.Line }
func (ls *LoopStatement) String() string {
	var out bytes.Buffer
	out.WriteString("循 { ")
	for _, stmt := range ls.Block {
		out.WriteString(stmt.String())
		out.WriteString(" ")
	}
	out.WriteString("}")
	return out.String()
}

// WhileStatement 循环语句
type WhileStatement struct {
	Token     token.Token
	Condition Expression
	Block     []Statement
}

func (ws *WhileStatement) statementNode()       {}
func (ws *WhileStatement) TokenLiteral() string { return ws.Token.Literal }
func (ws *WhileStatement) GetLine() int         { return ws.Token.Line }
func (ws *WhileStatement) String() string {
	var out bytes.Buffer
	out.WriteString("当 ")
	if ws.Condition != nil {
		out.WriteString(ws.Condition.String())
	}
	out.WriteString(" { ")
	for _, stmt := range ws.Block {
		out.WriteString(stmt.String())
		out.WriteString(" ")
	}
	out.WriteString("}")
	return out.String()
}

// TryCatchStatement 尝试/捕捉语句
type TryCatchStatement struct {
	Token      token.Token // "尝试"
	TryBlock   []Statement
	CatchToken token.Token // "捕捉"
	CatchVar   *Identifier // 捕捉到的异常变量名
	CatchBlock []Statement
}

func (ts *TryCatchStatement) statementNode()       {}
func (ts *TryCatchStatement) TokenLiteral() string { return ts.Token.Literal }
func (ts *TryCatchStatement) GetLine() int         { return ts.Token.Line }
func (ts *TryCatchStatement) String() string {
	var out bytes.Buffer
	out.WriteString("尝试 { ")
	for _, s := range ts.TryBlock {
		out.WriteString(s.String())
	}
	out.WriteString(" } 捕捉 (")
	if ts.CatchVar != nil {
		out.WriteString(ts.CatchVar.String())
	}
	out.WriteString(") { ")
	for _, s := range ts.CatchBlock {
		out.WriteString(s.String())
	}
	out.WriteString(" }")
	return out.String()
}

// TypeLiteral 类型字面量（用于“是”判断）
type TypeLiteral struct {
	Token token.Token // "整", "字", "逻", "小数", "数组", "字典", "空"
	Value string
}

func (tl *TypeLiteral) expressionNode()      {}
func (tl *TypeLiteral) TokenLiteral() string { return tl.Token.Literal }
func (tl *TypeLiteral) GetLine() int         { return tl.Token.Line }
func (tl *TypeLiteral) String() string       { return tl.Value }

// TypeDefinitionStatement 类型定义语句
type TypeDefinitionStatement struct {
	Token token.Token // "型"
	Name  *Identifier
	Block []Statement
}

func (tds *TypeDefinitionStatement) statementNode()       {}
func (tds *TypeDefinitionStatement) TokenLiteral() string { return tds.Token.Literal }
func (tds *TypeDefinitionStatement) GetLine() int         { return tds.Token.Line }
func (tds *TypeDefinitionStatement) String() string {
	var out bytes.Buffer
	out.WriteString("型 ")
	out.WriteString(tds.Name.String())
	out.WriteString(" { ")
	for _, stmt := range tds.Block {
		out.WriteString(stmt.String())
		out.WriteString(" ")
	}
	out.WriteString("}")
	return out.String()
}

// NewExpression 实例化表达式
type NewExpression struct {
	Token token.Token // "造"
	Type  Expression  // Identifier
	Data  Expression  // DictLiteral for initial values
}

func (ne *NewExpression) expressionNode()      {}
func (ne *NewExpression) TokenLiteral() string { return ne.Token.Literal }
func (ne *NewExpression) GetLine() int         { return ne.Token.Line }
func (ne *NewExpression) String() string {
	var out bytes.Buffer
	out.WriteString("造 ")
	out.WriteString(ne.Type.String())
	if ne.Data != nil {
		out.WriteString(ne.Data.String())
	}
	return out.String()
}

// SerializeExpression 序列化表达式
type SerializeExpression struct {
	Token token.Token // "化"
	Value Expression
}

func (se *SerializeExpression) expressionNode()      {}
func (se *SerializeExpression) TokenLiteral() string { return se.Token.Literal }
func (se *SerializeExpression) GetLine() int         { return se.Token.Line }
func (se *SerializeExpression) String() string {
	return "化(" + se.Value.String() + ")"
}

// DeserializeExpression 反序列化表达式
type DeserializeExpression struct {
	Token token.Token // "解"
	Value Expression
}

func (de *DeserializeExpression) expressionNode()      {}
func (de *DeserializeExpression) TokenLiteral() string { return de.Token.Literal }
func (de *DeserializeExpression) GetLine() int         { return de.Token.Line }
func (de *DeserializeExpression) String() string {
	return "解(" + de.Value.String() + ")"
}

// AsyncExpression 异步执行表达式
type AsyncExpression struct {
	Token token.Token // "异步"
	Block []Statement
}

func (ae *AsyncExpression) expressionNode()      {}
func (ae *AsyncExpression) TokenLiteral() string { return ae.Token.Literal }
func (ae *AsyncExpression) GetLine() int         { return ae.Token.Line }
func (ae *AsyncExpression) String() string {
	var out bytes.Buffer
	out.WriteString("异步 { ")
	for _, s := range ae.Block {
		out.WriteString(s.String())
	}
	out.WriteString(" }")
	return out.String()
}

// ParallelExpression 并行执行表达式
type ParallelExpression struct {
	Token  token.Token // "并行"
	Blocks [][]Statement
}

func (pe *ParallelExpression) expressionNode()      {}
func (pe *ParallelExpression) TokenLiteral() string { return pe.Token.Literal }
func (pe *ParallelExpression) GetLine() int         { return pe.Token.Line }
func (pe *ParallelExpression) String() string {
	var out bytes.Buffer
	out.WriteString("并行 { ")
	for _, b := range pe.Blocks {
		out.WriteString("{ ")
		for _, s := range b {
			out.WriteString(s.String())
		}
		out.WriteString(" } ")
	}
	out.WriteString(" }")
	return out.String()
}

// AwaitExpression 等待异步结果表达式
type AwaitExpression struct {
	Token token.Token // "等待"
	Value Expression
}

func (ae *AwaitExpression) expressionNode()      {}
func (ae *AwaitExpression) TokenLiteral() string { return ae.Token.Literal }
func (ae *AwaitExpression) GetLine() int         { return ae.Token.Line }
func (ae *AwaitExpression) String() string {
	return "等待(" + ae.Value.String() + ")"
}

// MemberCallExpression 链式成员调用
type MemberCallExpression struct {
	Token     token.Token // "."
	Object    Expression
	Member    *Identifier // 如 "接着" 或 "否则"
	Arguments []Expression
}

func (mce *MemberCallExpression) expressionNode()      {}
func (mce *MemberCallExpression) TokenLiteral() string { return mce.Token.Literal }
func (mce *MemberCallExpression) GetLine() int         { return mce.Token.Line }
func (mce *MemberCallExpression) String() string {
	var out bytes.Buffer
	out.WriteString(mce.Object.String())
	out.WriteString(".")
	out.WriteString(mce.Member.String())
	out.WriteString("(")
	args := []string{}
	for _, a := range mce.Arguments {
		args = append(args, a.String())
	}
	out.WriteString(strings.Join(args, ", "))
	out.WriteString(")")
	return out.String()
}

// IndexExpression 索引访问表达式
type IndexExpression struct {
	Token token.Token // '['
	Left  Expression
	Index Expression
}

func (ie *IndexExpression) expressionNode()      {}
func (ie *IndexExpression) TokenLiteral() string { return ie.Token.Literal }
func (ie *IndexExpression) GetLine() int         { return ie.Token.Line }
func (ie *IndexExpression) String() string {
	var out bytes.Buffer
	out.WriteString("(")
	out.WriteString(ie.Left.String())
	out.WriteString("[")
	out.WriteString(ie.Index.String())
	out.WriteString("])")
	return out.String()
}

// IntegerLiteral 整数字面量
type IntegerLiteral struct {
	Token token.Token
	Value int64
}

func (il *IntegerLiteral) expressionNode()      {}
func (il *IntegerLiteral) TokenLiteral() string { return il.Token.Literal }
func (il *IntegerLiteral) GetLine() int         { return il.Token.Line }
func (il *IntegerLiteral) String() string {
	return strconv.FormatInt(il.Value, 10)
}

// FloatLiteral 浮点数字面量
type FloatLiteral struct {
	Token token.Token
	Value float64
}

func (fl *FloatLiteral) expressionNode()      {}
func (fl *FloatLiteral) TokenLiteral() string { return fl.Token.Literal }
func (fl *FloatLiteral) GetLine() int         { return fl.Token.Line }
func (fl *FloatLiteral) String() string {
	return strconv.FormatFloat(fl.Value, 'g', -1, 64)
}

// StringLiteral 字符串字面量
type StringLiteral struct {
	Token token.Token
	Value string
}

func (sl *StringLiteral) expressionNode()      {}
func (sl *StringLiteral) TokenLiteral() string { return sl.Token.Literal }
func (sl *StringLiteral) GetLine() int         { return sl.Token.Line }
func (sl *StringLiteral) String() string {
	return "\"" + sl.Value + "\""
}

// BooleanLiteral 布尔字面量
type BooleanLiteral struct {
	Token token.Token
	Value bool
}

func (bl *BooleanLiteral) expressionNode()      {}
func (bl *BooleanLiteral) TokenLiteral() string { return bl.Token.Literal }
func (bl *BooleanLiteral) GetLine() int         { return bl.Token.Line }
func (bl *BooleanLiteral) String() string {
	if bl.Value {
		return "真"
	}
	return "假"
}

// ArrayLiteral 数组字面量
type ArrayLiteral struct {
	Token    token.Token // '['
	Elements []Expression
}

func (al *ArrayLiteral) expressionNode()      {}
func (al *ArrayLiteral) TokenLiteral() string { return al.Token.Literal }
func (al *ArrayLiteral) GetLine() int         { return al.Token.Line }
func (al *ArrayLiteral) String() string {
	var out bytes.Buffer
	elements := []string{}
	for _, e := range al.Elements {
		elements = append(elements, e.String())
	}
	out.WriteString("[")
	out.WriteString(strings.Join(elements, ", "))
	out.WriteString("]")
	return out.String()
}

// DictLiteral 字典字面量
type DictLiteral struct {
	Token token.Token // '{'
	Pairs map[Expression]Expression
}

func (dl *DictLiteral) expressionNode()      {}
func (dl *DictLiteral) TokenLiteral() string { return dl.Token.Literal }
func (dl *DictLiteral) GetLine() int         { return dl.Token.Line }
func (dl *DictLiteral) String() string {
	var out bytes.Buffer
	pairs := []string{}
	for key, value := range dl.Pairs {
		pairs = append(pairs, key.String()+":"+value.String())
	}
	out.WriteString("{")
	out.WriteString(strings.Join(pairs, ", "))
	out.WriteString("}")
	return out.String()
}

// Identifier 标识符
type Identifier struct {
	Token token.Token
	Value string
}

func (i *Identifier) expressionNode()      {}
func (i *Identifier) TokenLiteral() string { return i.Token.Literal }
func (i *Identifier) GetLine() int         { return i.Token.Line }
func (i *Identifier) String() string {
	return i.Value
}

// PrefixExpression 前缀表达式
type PrefixExpression struct {
	Token    token.Token
	Operator string
	Right    Expression
}

func (pe *PrefixExpression) expressionNode()      {}
func (pe *PrefixExpression) TokenLiteral() string { return pe.Token.Literal }
func (pe *PrefixExpression) GetLine() int         { return pe.Token.Line }
func (pe *PrefixExpression) String() string {
	var out bytes.Buffer
	out.WriteString("(")
	out.WriteString(pe.Operator)
	if pe.Right != nil {
		out.WriteString(pe.Right.String())
	}
	out.WriteString(")")
	return out.String()
}

// InfixExpression 中缀表达式
type InfixExpression struct {
	Token    token.Token
	Left     Expression
	Operator string
	Right    Expression
}

func (ie *InfixExpression) expressionNode()      {}
func (ie *InfixExpression) TokenLiteral() string { return ie.Token.Literal }
func (ie *InfixExpression) GetLine() int         { return ie.Token.Line }
func (ie *InfixExpression) String() string {
	var out bytes.Buffer
	out.WriteString("(")
	if ie.Left != nil {
		out.WriteString(ie.Left.String())
	}
	out.WriteString(" " + ie.Operator + " ")
	if ie.Right != nil {
		out.WriteString(ie.Right.String())
	}
	out.WriteString(")")
	return out.String()
}

// FunctionLiteral 函数定义
type FunctionLiteral struct {
	Token      token.Token
	Parameters []*Identifier
	Body       []Statement
}

func (fl *FunctionLiteral) expressionNode()      {}
func (fl *FunctionLiteral) TokenLiteral() string { return fl.Token.Literal }
func (fl *FunctionLiteral) GetLine() int         { return fl.Token.Line }
func (fl *FunctionLiteral) String() string {
	var out bytes.Buffer
	params := []string{}
	for _, p := range fl.Parameters {
		params = append(params, p.String())
	}
	out.WriteString("函数")
	out.WriteString("(")
	out.WriteString(strings.Join(params, ", "))
	out.WriteString(") { ")
	for _, s := range fl.Body {
		out.WriteString(s.String())
	}
	out.WriteString(" }")
	return out.String()
}

// ExpressionStatement 表达式语句
type ExpressionStatement struct {
	Token      token.Token
	Expression Expression
}

func (es *ExpressionStatement) statementNode()       {}
func (es *ExpressionStatement) TokenLiteral() string { return es.Token.Literal }
func (es *ExpressionStatement) GetLine() int         { return es.Token.Line }
func (es *ExpressionStatement) String() string {
	if es.Expression != nil {
		return es.Expression.String()
	}
	return ""
}

// CallExpression 函数调用
type CallExpression struct {
	Token     token.Token // '('
	Function  Expression  // Identifier or FunctionLiteral
	Arguments []Expression
}

func (ce *CallExpression) expressionNode()      {}
func (ce *CallExpression) TokenLiteral() string { return ce.Token.Literal }
func (ce *CallExpression) GetLine() int         { return ce.Token.Line }
func (ce *CallExpression) String() string {
	var out bytes.Buffer
	args := []string{}
	for _, a := range ce.Arguments {
		args = append(args, a.String())
	}
	out.WriteString(ce.Function.String())
	out.WriteString("(")
	out.WriteString(strings.Join(args, ", "))
	out.WriteString(")")
	return out.String()
}

// ReturnStatement 返回语句
type ReturnStatement struct {
	Token       token.Token
	ReturnValue Expression
}

func (rs *ReturnStatement) statementNode()       {}
func (rs *ReturnStatement) TokenLiteral() string { return rs.Token.Literal }
func (rs *ReturnStatement) GetLine() int         { return rs.Token.Line }
func (rs *ReturnStatement) String() string {
	var out bytes.Buffer
	out.WriteString("返回 ")
	if rs.ReturnValue != nil {
		out.WriteString(rs.ReturnValue.String())
	}
	return out.String()
}

// ImportExpression 引用表达式
type ImportExpression struct {
	Token token.Token // "引用"
	Path  string      // 路径字符串
}

func (ie *ImportExpression) expressionNode()      {}
func (ie *ImportExpression) TokenLiteral() string { return ie.Token.Literal }
func (ie *ImportExpression) GetLine() int         { return ie.Token.Line }
func (ie *ImportExpression) String() string {
	return "引用 \"" + ie.Path + "\""
}

// ForStatement 遍历语句
type ForStatement struct {
	Token    token.Token // "遍历"
	Variable *Identifier
	Iterable Expression
	Block    []Statement
}

func (fs *ForStatement) statementNode()       {}
func (fs *ForStatement) TokenLiteral() string { return fs.Token.Literal }
func (fs *ForStatement) GetLine() int         { return fs.Token.Line }
func (fs *ForStatement) String() string {
	var out bytes.Buffer
	out.WriteString("遍历 ")
	out.WriteString(fs.Variable.String())
	out.WriteString(" 于 ")
	out.WriteString(fs.Iterable.String())
	out.WriteString(" { ")
	for _, s := range fs.Block {
		out.WriteString(s.String())
	}
	out.WriteString(" }")
	return out.String()
}

// BreakStatement 跳出语句
type BreakStatement struct {
	Token token.Token // "跳出"
}

func (bs *BreakStatement) statementNode()       {}
func (bs *BreakStatement) TokenLiteral() string { return bs.Token.Literal }
func (bs *BreakStatement) GetLine() int         { return bs.Token.Line }
func (bs *BreakStatement) String() string       { return "跳出" }

// ContinueStatement 继续语句
type ContinueStatement struct {
	Token token.Token // "继续"
}

func (cs *ContinueStatement) statementNode()       {}
func (cs *ContinueStatement) TokenLiteral() string { return cs.Token.Literal }
func (cs *ContinueStatement) GetLine() int         { return cs.Token.Line }
func (cs *ContinueStatement) String() string       { return "继续" }
