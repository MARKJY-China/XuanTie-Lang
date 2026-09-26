# -*- coding: utf-8 -*-
# 句读参考解释器(tree-walk,可执行规范)
# 与转译器(src/*.xt)同构异码;语义细则唯一事实源为 规范.md。
# 黄金测试三方比对:转译链路输出、本解释器输出、期望,逐字节一致(仅归一化换行)方绿。
#
# 已锁语义要点(与转译器一致,改动必须先改规范):
#   * 整除向零取整;余之号随被除数;除零余零报【零除之失】
#   * 且/或两边皆求值(不短路)
#   * 加:数+数;文+任意(左文);列+列;余者【异类之失】
#   * 受三解:诀调用/册查键(无键得空)/列一基索引;键文直书与双态依运行时型裁决
#   * 纳于未立之名者立之(块内);读未立之名【虚指之失】
#   * 口诀:有序规则,首中即行;非止规则更新 v(文模式施最左置换)复自首条;
#           递归触发逾一万次【循环之失】(报于口诀定义之行)
#   * 《度》:文字符数/列元数/册键数;《签》:一至该数闭区间;《问》:合数词为数否则为文,EOF 得空文
import sys, random

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        try:
            _s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


class 译错(Exception):
    def __init__(self, 类目, 消息, 行):
        self.类目 = 类目
        self.消息 = 消息
        self.行 = 行
        super().__init__(消息)


class 上下文:
    def __init__(self, 卷名, 源行们):
        self.卷名 = 卷名
        self.源行们 = 源行们


_ctx = None


def 报错(类目, 消息, 行):
    源 = ""
    if 1 <= 行 <= len(_ctx.源行们):
        源 = _ctx.源行们[行 - 1]
    线 = "～" * len(源)
    print("【" + 类目 + "】卷「" + _ctx.卷名 + "」第" + 转中文(行) + "行:" + 消息)
    print("　" + 源)
    print("　" + 线)
    sys.stdout.flush()
    sys.exit(1)


def 转中文(n):
    if n <= 0:
        return "〇"
    字表 = ["〇", "一", "二", "三", "四", "五", "六", "七", "八", "九"]
    出 = ""
    千 = n // 1000
    余 = n % 1000
    if 千 > 0:
        出 += 字表[千] + "千"
        if 0 < 余 < 100:
            出 += "零"
    百 = 余 // 100
    余 = 余 % 100
    if 百 > 0:
        出 += 字表[百] + "百"
        if 0 < 余 < 10:
            出 += "零"
    十 = 余 // 10
    个 = 余 % 10
    if 十 > 0:
        if 十 == 1 and 千 == 0 and 百 == 0:
            出 += "十"
        else:
            出 += 字表[十] + "十"
    if 个 > 0:
        出 += 字表[个]
    return 出 if 出 else "〇"


# ---------- 数词(镜像 词数.xt) ----------

def 数值字(c):
    return {"〇": 0, "零": 0, "一": 1, "二": 2, "三": 3, "四": 4,
            "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}.get(c, -1)


def 是位词(c):
    return c in ("十", "百", "千")


def 解数词(串):
    字们 = list(串)
    n = len(字们)
    if n == 0:
        return [False, 0]
    负号 = False
    起 = 0
    if 字们[0] == "负":
        负号 = True
        起 = 1
        if n == 1:
            return [False, 0]
    有位 = any(是位词(字们[i]) for i in range(起, n))
    值 = 0
    if not 有位:
        位权 = 1
        i = n - 1
        while i >= 起:
            d = 数值字(字们[i])
            if d < 0:
                return [False, 0]
            值 += d * 位权
            位权 *= 10
            i -= 1
    else:
        暂 = 0
        前为数字 = False
        i = 起
        while i < n:
            c = 字们[i]
            d = 数值字(c)
            if d >= 0:
                if 前为数字 and 暂 != 0:
                    return [False, 0]
                暂 = 暂 * 10 + d
                前为数字 = True
            elif 是位词(c):
                底 = 暂 if 暂 != 0 else 1
                if c == "十":
                    值 += 底 * 10
                elif c == "百":
                    值 += 底 * 100
                else:
                    值 += 底 * 1000
                暂 = 0
                前为数字 = False
            else:
                return [False, 0]
            i += 1
        值 += 暂
        if 值 > 9999:
            return [False, 0]
    if 负号:
        值 = -值
    return [True, 值]


# ---------- 词法(镜像 词法.xt) ----------

def 归一符(c):
    if c == "　":
        return " "
    return {"，": ",", "、": ",", "。": ".", "：": ":", "？": "?", "！": "!",
            "「": "[", "」": "]", "《": "<", "》": ">"}.get(c, c)


拼音表 = {
    "zhe": "者", "ye": "也", "ruo": "若", "ze": "则", "buran": "不然",
    "buranruo": "不然若", "xun": "循", "shou": "受", "guyue": "故曰",
    "na": "纳", "yu": "于", "jue": "诀", "jian": "见", "dang": "当",
    "zhi": "止", "shu": "书", "num": "型数", "wen": "型文", "lie": "型列",
    "ce": "型册", "ranfou": "型然否", "ran": "然", "fou": "否", "kong": "空",
    "jia": "加", "cheng": "乘", "chu": "除", "fei": "非", "qie": "且",
    "huo": "或", "dayu": "大于", "xiaoyu": "小于", "dengyu": "等于",
    "budayu": "不大于", "buxiaoyu": "不小于", "budengyu": "不等于", "fu": "负",
}

尊名表 = {"问": "问", "签": "签", "度": "度", "wen": "问", "qian": "签", "du": "度"}

三字词 = {"不然若": "不然若", "不大于": "不大于", "不小于": "不小于", "不等于": "不等于"}
二字词 = {"不然": "不然", "故曰": "故曰", "然否": "型然否", "大于": "大于",
          "小于": "小于", "等于": "等于"}
单字表 = {"者": "者", "也": "也", "若": "若", "则": "则", "循": "循", "受": "受",
          "纳": "纳", "于": "于", "诀": "诀", "见": "见", "当": "当", "止": "止",
          "书": "书", "加": "加", "减": "减", "乘": "乘", "除": "除", "余": "余",
          "且": "且", "或": "或", "非": "非", "负": "负", "然": "然", "否": "否",
          "空": "空", "数": "型数", "文": "型文", "列": "型列", "册": "型册"}

续行集 = {"加", "减", "乘", "除", "余", "大于", "小于", "等于", "不大于", "不小于",
          "不等于", "且", "或", "非", "负", "受", "故曰", "逗", "开", "续行"}


def 是数词字(c):
    return c in ("〇", "零", "一", "二", "三", "四", "五", "六", "七", "八",
                 "九", "十", "百", "千")


def 名禁字(c):
    if c in (" ", "\t", "\n"):
        return True
    形 = 归一符(c)
    if 形 in (",", ".", ";", ":", "?", "!", "[", "]", "<", ">"):
        return True
    if c in ("…", "(", ")", "{", "}", '"', "'", "\\", "+", "-", "*", "/",
             "%", "=", "&", "|", "^", "~", "#", "$", "@"):
        return True
    return False


class 词法器:
    def __init__(self, 源文, 卷名):
        self.源字 = list(源文)
        self.总长 = len(self.源字)
        self.位置 = 0
        self.行 = 1
        self.卷名 = 卷名

    def 译错(self, 消息, 行=None):
        raise 译错("文法之失", 消息, self.行 if 行 is None else 行)

    def 现字(self):
        return self.源字[self.位置] if self.位置 < self.总长 else "终止"

    def 望字(self, 偏):
        i = self.位置 + 偏
        return self.源字[i] if i < self.总长 else "终止"

    def 进(self):
        if self.位置 < self.总长:
            if self.源字[self.位置] == "\n":
                self.行 += 1
            self.位置 += 1

    def 掠至行末(self):
        while self.现字() not in ("\n", "终止"):
            self.进()

    def 取段(self, 起, 长):
        return "".join(self.源字[起:起 + 长])

    def 掠文面(self, 起位):
        开符 = self.源字[起位]
        阖符 = "」" if 开符 == "「" else "]"
        i = 起位 + 2
        深 = 0
        while i < self.总长:
            c = self.源字[i]
            if c == "\n":
                return [False, "", i]
            if c == 开符:
                深 += 1
                i += 1
            elif c == 阖符:
                if 深 > 0:
                    深 -= 1
                    i += 1
                else:
                    if i + 1 < self.总长 and self.源字[i + 1] == 阖符:
                        return [True, self.取段(起位 + 2, i - 起位 - 2), i + 2]
                    return [False, "", i]
            else:
                i += 1
        return [False, "", i]

    def 掠括内(self, 起位):
        i = 起位 + 1
        深 = 1
        while i < self.总长:
            c = self.源字[i]
            if c in ("[", "「"):
                if i + 1 < self.总长 and self.源字[i + 1] in ("[", "「"):
                    r = self.掠文面(i)
                    if not r[0]:
                        return ["", -1]
                    i = r[2]
                    continue
                深 += 1
                i += 1
            elif c in ("]", "」"):
                深 -= 1
                if 深 == 0:
                    return [self.取段(起位 + 1, i - 起位 - 1), i]
                i += 1
            else:
                i += 1
        return ["", -1]

    def 全部标记(self):
        标记们 = []
        括深 = 0
        while True:
            while True:
                c = 归一符(self.现字())
                if c in (" ", "\t", ":", "?"):
                    self.进()
                else:
                    break
            c = 归一符(self.现字())
            if c == "终止":
                break
            if c == "批":
                self.掠至行末()
                continue
            if c == "/":
                if 归一符(self.望字(1)) == "/":
                    self.掠至行末()
                    continue
                标记们.append(["除", "", self.行, 0])
                self.进()
                continue
            if c == "+":
                标记们.append(["加", "", self.行, 0])
                self.进()
                continue
            if c == "-":
                标记们.append(["减", "", self.行, 0])
                self.进()
                continue
            if c == "*":
                标记们.append(["乘", "", self.行, 0])
                self.进()
                continue
            if c == "%":
                标记们.append(["余", "", self.行, 0])
                self.进()
                continue
            if c == "=":
                if 归一符(self.望字(1)) == "=":
                    标记们.append(["等于", "", self.行, 0])
                    self.进(); self.进()
                    continue
                self.译错("句读无赋值符,纳…于…是赋。")
            if c == "&":
                if 归一符(self.望字(1)) == "&":
                    标记们.append(["且", "", self.行, 0])
                    self.进(); self.进()
                    continue
                self.译错("未识之符「&」(且须双书 &&)。")
            if c == "|":
                if 归一符(self.望字(1)) == "|":
                    标记们.append(["或", "", self.行, 0])
                    self.进(); self.进()
                    continue
                self.译错("未识之符「|」(或须双书 ||)。")
            if c == "\n":
                if 括深 > 0 or (标记们 and 标记们[-1][0] in 续行集):
                    self.进()
                    continue
                标记们.append(["句终", "", self.行, 0])
                self.进()
                continue
            if c == ".":
                if 归一符(self.望字(1)) == ".":
                    标记们.append(["续行", "", self.行, 0])
                    self.进(); self.进()
                    continue
                标记们.append(["句终", "", self.行, 0])
                self.进()
                continue
            if c == ";":
                标记们.append(["句终", "", self.行, 0])
                self.进()
                continue
            if c == "…":
                if self.望字(1) == "…":
                    标记们.append(["续行", "", self.行, 0])
                    self.进(); self.进()
                    continue
                self.译错("续行号须双书(……)。")
            if c == ",":
                标记们.append(["逗", "", self.行, 0])
                self.进()
                continue
            if c == "!":
                标记们.append(["非", "", self.行, 0])
                self.进()
                continue
            if c == "[":
                if 归一符(self.望字(1)) == "[":
                    r = self.掠文面(self.位置)
                    if r[0]:
                        标记们.append(["文面", r[1], self.行, 0])
                        跳 = r[2] - self.位置
                        for _ in range(跳):
                            self.进()
                        continue
                    # 非串:落开括路径
                内 = self.掠括内(self.位置)
                if 内[1] < 0:
                    self.译错("括未阖。")
                if 内[0] and not any(名禁字(ch) for ch in 内[0]):
                    试 = 解数词(内[0])
                    数性 = 1 if 试[0] else 0
                    标记们.append(["名", 内[0], self.行, 数性])
                    跳名 = 内[1] + 1 - self.位置
                    for _ in range(跳名):
                        self.进()
                else:
                    括深 += 1
                    标记们.append(["开", "", self.行, 0])
                    self.进()
                continue
            if c == "]":
                if 括深 <= 0:
                    self.译错("括未开而阖。")
                括深 -= 1
                标记们.append(["阖", "", self.行, 0])
                self.进()
                continue
            if c == "<":
                i = self.位置 + 1
                内容 = ""
                已阖 = False
                while i < self.总长:
                    cc = 归一符(self.源字[i])
                    if cc == ">":
                        已阖 = True
                        break
                    if cc == "\n":
                        break
                    内容 += cc
                    i += 1
                if not 已阖:
                    self.译错("尊名未阖。")
                尊 = 尊名表.get(内容, "")
                if 尊 == "":
                    self.译错("未识之尊名《" + 内容 + "》(v0.1 仅问、签、度)。")
                标记们.append(["尊名", 尊, self.行, 0])
                跳 = i + 1 - self.位置
                for _ in range(跳):
                    self.进()
                continue
            if c == ">":
                self.译错("尊括未开而阖。")
            if c in "0123456789":
                s = ""
                while True:
                    cc = 归一符(self.现字())
                    if cc in "0123456789":
                        s += cc
                        self.进()
                    else:
                        break
                标记们.append(["数", s, self.行, 0])
                continue
            if 是数词字(c) or (c == "负" and 是数词字(归一符(self.望字(1)))):
                s = ""
                while True:
                    cc = self.现字()
                    if 是数词字(cc) or (s == "" and cc == "负"):
                        s += cc
                        self.进()
                    else:
                        break
                试 = 解数词(s)
                if not 试[0]:
                    self.译错("数词之形不合规:「" + s + "」。")
                标记们.append(["数", str(试[1]), self.行, 0])
                continue
            if "a" <= c <= "z":
                s = ""
                while True:
                    cc = self.现字()
                    if "a" <= cc <= "z":
                        s += cc
                        self.进()
                    else:
                        break
                if s == "pi":
                    self.掠至行末()
                    continue
                标 = 拼音表.get(s, "")
                if 标 == "":
                    self.译错("未识之词「" + s + "」。")
                标记们.append([标, "", self.行, 0])
                continue
            c2 = self.望字(1)
            c3 = self.望字(2)
            三 = c + c2 + c3
            二 = c + c2
            if 三 in 三字词:
                标记们.append([三字词[三], "", self.行, 0])
                self.进(); self.进(); self.进()
                continue
            if 二 in 二字词:
                标记们.append([二字词[二], "", self.行, 0])
                self.进(); self.进()
                continue
            if c in 单字表:
                标记们.append([单字表[c], "", self.行, 0])
                self.进()
                continue
            self.译错("未识之字「" + c + "」。")
        标记们.append(["卷终", "", self.行, 0])
        return 标记们


# ---------- 语法(镜像 语法.xt;节点即字典) ----------

比较词集 = ("大于", "小于", "等于", "不大于", "不小于", "不等于")


class 语法器:
    def __init__(self, 标记们, 卷名):
        self.标记们 = 标记们
        self.总数 = len(标记们)
        self.位 = 0
        self.卷名 = 卷名
        self.诀深 = 0
        self.诀首态 = 0

    def 译错(self, 消息):
        raise 译错("文法之失", 消息, self.现()[2])

    def 现(self):
        return self.标记们[min(self.位, self.总数 - 1)]

    def 类(self):
        return self.现()[0]

    def 望类(self, 偏):
        i = self.位 + 偏
        return self.标记们[i][0] if i < self.总数 else "卷终"

    def 进(self):
        if self.位 < self.总数 - 1:
            self.位 += 1

    def 望(self, 类型, 何物):
        if self.类() != 类型:
            self.译错("期望" + 何物 + ",今得「" + self.类() + "」。")
        t = self.现()
        self.进()
        return t

    def 跳句终(self):
        while self.类() in ("句终", "逗"):
            self.进()

    def 收句尾(self):
        self.跳句终()

    def 解程序(self):
        句们 = []
        self.跳句终()
        while self.类() != "卷终":
            句们.append(self.解语句())
            self.跳句终()
        return 句们

    def 解语句(self):
        self.跳句终()
        t = self.类()
        if t == "名":
            return self.解名首句()
        if t == "纳":
            return self.解赋值()
        if t == "书":
            行 = self.行号()
            self.进()
            e = self.解表达式()
            self.收句尾()
            return {"类": "输出", "值": e, "行": 行}
        if t == "若":
            return self.解条件()
        if t == "循":
            return self.解循环()
        if t == "受":
            return self.解受句()
        if t == "故曰":
            return self.解故曰()
        if t == "止":
            行 = self.行号()
            self.进()
            self.收句尾()
            return {"类": "止句", "行": 行}
        if t == "见":
            self.译错("「见」唯居于口诀体之首。")
        if t == "不然":
            self.译错("「不然」须居若块之末或口诀之末。")
        if t == "不然若":
            self.译错("「不然若」须承若块。")
        if t == "诀":
            self.译错("「诀」须随「名者,诀也」之声明。")
        行 = self.行号()
        e = self.解表达式()
        self.收句尾()
        return {"类": "表达式语句", "值": e, "行": 行}

    def 行号(self):
        return self.现()[2]

    def 解名首句(self):
        if self.望类(1) == "者":
            return self.解声明()
        行 = self.行号()
        e = self.解表达式()
        self.收句尾()
        return {"类": "表达式语句", "值": e, "行": 行}

    def 解声明(self):
        名t = self.望("名", "名引")
        行 = 名t[2]
        self.望("者", "「者」")
        self.跳句终()
        t = self.类()
        型词表 = {"型数": "数", "型文": "文", "型列": "列", "型册": "册",
                  "型然否": "然否", "空": "空"}
        if t in 型词表 and self.望类(1) == "也":
            self.进(); self.进()
            self.收句尾()
            return {"类": "声明", "名": 名t[1], "值": {"类": "空值", "行": 行},
                    "型词": 型词表[t], "行": 行}
        if t == "诀":
            if self.望类(1) != "也":
                self.译错("「诀也」之后不得有他词。")
            self.进(); self.进()
            return self.解诀体(名t[1], 行)
        e = self.解表达式()
        self.望("也", "声明之「也」")
        self.收句尾()
        return {"类": "声明", "名": 名t[1], "值": e, "型词": "", "行": 行}

    def 解诀体(self, 名, 行):
        self.诀深 += 1
        self.跳句终()
        口诀体 = self.类() == "见"
        体 = []
        规则 = []
        参名 = ""
        if 口诀体:
            while self.类() == "见":
                规则.append(self.解规则())
                self.跳句终()
            if self.类() == "不然":
                规则.append(self.解不然规则())
                self.跳句终()
            self.望("也", "口诀体末之「也」")
        else:
            首句 = True
            while True:
                self.跳句终()
                if self.类() == "也":
                    self.进()
                    break
                if self.类() == "卷终":
                    self.译错("诀体未阖,缺「也」。")
                if 首句:
                    self.诀首态 = 1
                    if self.类() == "受":
                        self.望("受", "「受」")
                        名t = self.望("名", "参名")
                        参名 = 名t[1]
                        self.收句尾()
                        self.诀首态 = 2
                        首句 = False
                        continue
                体.append(self.解语句())
                self.诀首态 = 2
                首句 = False
        self.诀深 -= 1
        self.诀首态 = 0
        return {"类": "诀定义", "名": 名, "体": 体, "规则": 规则, "参": 参名,
                "口诀": 口诀体, "行": 行}

    def 解规则(self):
        行 = self.行号()
        self.望("见", "「见」")
        模式 = self.解模式()
        当节 = {"类": "空值", "行": 行}
        if self.类() == "当":
            self.进()
            当节 = self.解表达式()
        self.跳句终()
        self.望("则", "规则之「则」")
        动作 = self.解表达式()
        止 = False
        if self.类() == "止":
            self.进()
            止 = True
        self.收句尾()
        return {"类": "规则", "模式": 模式, "当": 当节, "动作": 动作,
                "止": 止, "兜底": False, "行": 行}

    def 解不然规则(self):
        行 = self.行号()
        self.望("不然", "「不然」")
        if self.类() == "当":
            self.译错("兜底规则恒中,不得带「当」。")
        if self.类() == "则":
            self.进()
        动作 = self.解表达式()
        止 = False
        if self.类() == "止":
            self.进()
            止 = True
        self.收句尾()
        return {"类": "规则", "模式": {"类": "空值", "行": 行}, "当": {"类": "空值", "行": 行},
                "动作": 动作, "止": 止, "兜底": True, "行": 行}

    def 解模式(self):
        t = self.类()
        行 = self.行号()
        if t == "名":
            名t = self.望("名", "模式名")
            return {"类": "名", "名": 名t[1], "行": 行}
        if t == "数":
            数t = self.望("数", "模式之数")
            return {"类": "数", "值": 数t[1], "行": 行}
        if t == "文面":
            文t = self.望("文面", "模式之文")
            return {"类": "文", "值": 文t[1], "行": 行}
        if t == "型列":
            self.进()
            self.望("开", "列模式之开括")
            元们 = []
            self.跳句终()
            while self.类() != "阖":
                et = self.类()
                if et == "名":
                    名t = self.望("名", "列模式之项")
                    元们.append({"类": "名", "名": 名t[1], "行": 名t[2]})
                elif et == "数":
                    数t = self.望("数", "列模式之项")
                    元们.append({"类": "数", "值": 数t[1], "行": 数t[2]})
                elif et == "文面":
                    文t = self.望("文面", "列模式之项")
                    元们.append({"类": "文", "值": 文t[1], "行": 文t[2]})
                else:
                    self.译错("列模式之项唯名与字面量。")
                if self.类() == "逗":
                    self.进()
                    self.跳句终()
            self.望("阖", "列模式之阖括")
            return {"类": "列值", "元": 元们, "行": 行}
        self.译错("模式唯名、数、文、列四形。")

    def 解赋值(self):
        行 = self.行号()
        self.望("纳", "「纳」")
        e = self.解表达式()
        self.望("于", "「于」")
        目标 = self.解目标()
        self.收句尾()
        return {"类": "赋值", "目标": 目标, "值": e, "行": 行}

    def 解目标(self):
        名t = self.望("名", "赋值目标之名")
        行 = 名t[2]
        if self.类() == "受":
            self.进()
            实 = self.解原子()
            return {"类": "受用", "收": {"类": "名", "名": 名t[1], "行": 行},
                    "实": 实, "行": 行}
        return {"类": "名", "名": 名t[1], "行": 行}

    def 解条件(self):
        行 = self.行号()
        self.望("若", "「若」")
        d = {"类": "条件", "枝": [], "否则": [], "行": 行}
        条 = self.解表达式()
        self.望("则", "「则」")
        d["枝"].append({"当": 条, "体": self.解块()})
        while self.类() == "不然若":
            self.进()
            条2 = self.解表达式()
            self.望("则", "「则」")
            d["枝"].append({"当": 条2, "体": self.解块()})
        if self.类() == "不然":
            self.进()
            d["否则"] = self.解块()
        self.望("也", "若块末之「也」")
        self.收句尾()
        return d

    def 解块(self):
        句们 = []
        t = self.类()
        if t in ("句终", "逗"):
            self.跳句终()
            while True:
                self.跳句终()
                if self.类() == "也":
                    break
                if self.类() == "卷终":
                    self.译错("块未阖,缺「也」。")
                句们.append(self.解语句())
            return 句们
        if t == "也":
            self.译错("块中无句。")
        句们.append(self.解语句())
        return 句们

    def 解循环(self):
        行 = self.行号()
        self.望("循", "「循」")
        if self.类() == "名" and self.望类(1) == "于":
            名t = self.望("名", "遍历之名")
            self.望("于", "「于」")
            列e = self.解表达式()
            体 = self.解块()
            self.望("也", "循块末之「也」")
            self.收句尾()
            return {"类": "循环", "当型": False, "名": 名t[1], "条件": None,
                    "列": 列e, "体": 体, "行": 行}
        条 = self.解表达式()
        体 = self.解块()
        self.望("也", "循块末之「也」")
        self.收句尾()
        return {"类": "循环", "当型": True, "名": "", "条件": 条,
                "列": None, "体": 体, "行": 行}

    def 解受句(self):
        if self.诀深 == 0 or self.诀首态 != 1:
            self.译错("「受」引参之句唯居于诀体之首。")
        行 = self.行号()
        self.望("受", "「受」")
        名t = self.望("名", "参名")
        self.收句尾()
        return {"类": "受句", "名": 名t[1], "行": 行}

    def 解故曰(self):
        if self.诀深 == 0:
            self.译错("「故曰」越诀,不得居于诀体之外。")
        行 = self.行号()
        self.望("故曰", "「故曰」")
        e = self.解表达式()
        self.收句尾()
        return {"类": "故曰", "值": e, "行": 行}

    def 解表达式(self):
        return self.解或()

    def 解或(self):
        左 = self.解且()
        while self.类() == "或":
            行 = self.行号()
            self.进()
            右 = self.解且()
            左 = {"类": "二元", "运算": "或", "左": 左, "右": 右, "行": 行}
        return 左

    def 解且(self):
        左 = self.解比较()
        while self.类() == "且":
            行 = self.行号()
            self.进()
            右 = self.解比较()
            左 = {"类": "二元", "运算": "且", "左": 左, "右": 右, "行": 行}
        return 左

    def 解比较(self):
        左 = self.解加减()
        while self.类() in 比较词集:
            行 = self.行号()
            运 = self.类()
            self.进()
            右 = self.解加减()
            左 = {"类": "二元", "运算": 运, "左": 左, "右": 右, "行": 行}
        return 左

    def 解加减(self):
        左 = self.解乘除()
        while self.类() in ("加", "减"):
            行 = self.行号()
            运 = self.类()
            self.进()
            右 = self.解乘除()
            左 = {"类": "二元", "运算": 运, "左": 左, "右": 右, "行": 行}
        return 左

    def 解乘除(self):
        左 = self.解一元()
        while self.类() in ("乘", "除", "余"):
            行 = self.行号()
            运 = self.类()
            self.进()
            右 = self.解一元()
            左 = {"类": "二元", "运算": 运, "左": 左, "右": 右, "行": 行}
        return 左

    def 解一元(self):
        t = self.类()
        行 = self.行号()
        if t == "非":
            self.进()
            return {"类": "一元", "运算": "非", "子": self.解一元(), "行": 行}
        if t in ("负", "减"):
            self.进()
            return {"类": "一元", "运算": "负", "子": self.解一元(), "行": 行}
        return self.解受链()

    def 解受链(self):
        左 = self.解原子()
        while self.类() == "受":
            行 = self.行号()
            self.进()
            实 = self.解原子()
            左 = {"类": "受用", "收": 左, "实": 实, "行": 行}
        return 左

    def 解原子(self):
        t = self.类()
        行 = self.行号()
        if t == "数":
            数t = self.望("数", "数")
            return {"类": "数", "值": 数t[1], "行": 行}
        if t == "文面":
            文t = self.望("文面", "文")
            return {"类": "文", "值": 文t[1], "行": 行}
        if t == "名":
            名t = self.望("名", "名")
            return {"类": "名", "名": 名t[1], "行": 行}
        if t == "然":
            self.进()
            return {"类": "然", "真": True, "行": 行}
        if t == "否":
            self.进()
            return {"类": "然", "真": False, "行": 行}
        if t == "空":
            self.进()
            return {"类": "空值", "行": 行}
        if t == "尊名":
            尊t = self.望("尊名", "尊名")
            尊 = 尊t[1]
            if self.类() == "受":
                if 尊 == "问":
                    self.译错("《问》不受参。")
                self.进()
                实 = self.解原子()
                return {"类": "尊名", "名": 尊, "实": 实, "行": 行}
            if 尊 != "问":
                self.译错("《" + 尊 + "》必受一原子之参。")
            return {"类": "尊名", "名": 尊, "实": {"类": "空值", "行": 行}, "行": 行}
        if t == "型列":
            self.进()
            单类 = self.类()
            if 单类 in ("名", "文面", "数"):
                单t = self.现()
                if 单类 == "名":
                    if 单t[3] == 1:
                        试 = 解数词(单t[1])
                        元节 = {"类": "数", "值": str(试[1]), "行": 单t[2]}
                    else:
                        元节 = {"类": "名", "名": 单t[1], "行": 单t[2]}
                elif 单类 == "文面":
                    元节 = {"类": "文", "值": 单t[1], "行": 单t[2]}
                else:
                    元节 = {"类": "数", "值": 单t[1], "行": 单t[2]}
                self.进()
                return {"类": "列值", "元": [元节], "行": 行}
            self.望("开", "列字面量之开括")
            元们 = []
            self.跳句终()
            while self.类() != "阖":
                元们.append(self.解列元())
                if self.类() == "逗":
                    self.进()
                    self.跳句终()
                else:
                    break
            self.望("阖", "列字面量之阖括")
            return {"类": "列值", "元": 元们, "行": 行}
        if t == "开":
            self.译错("括不入式:名以引立,列以「列」起。")
        self.译错("不成原子:「" + t + "」。")

    def 解列元(self):
        if self.类() == "名":
            名t = self.现()
            if 名t[3] == 1:
                self.进()
                试 = 解数词(名t[1])
                return {"类": "数", "值": str(试[1]), "行": 名t[2]}
        return self.解表达式()


# ---------- 值与运行(镜像 jd_runtime.xt) ----------

class 盒:
    __slots__ = ("t", "n", "s", "l", "d", "b", "fn", "fname")

    def __init__(self, t):
        self.t = t
        self.n = 0
        self.s = ""
        self.l = None
        self.d = None
        self.b = False
        self.fn = None
        self.fname = ""


def 数盒(v):
    x = 盒(0); x.n = v; return x


def 文盒(s):
    x = 盒(1); x.s = s; return x


def 列盒(们):
    x = 盒(2); x.l = 们; return x


def 然盒(b):
    x = 盒(4); x.b = b; return x


def 册盒():
    x = 盒(3); x.d = {}; return x


def 空盒():
    return 盒(5)


def 诀盒(节点):
    x = 盒(6); x.fn = 节点; x.fname = 节点["名"]; return x


def 型名(x):
    return ("数", "文", "列", "册", "然否", "空", "诀")[x.t]


def 书形(x):
    if x.t == 0:
        return str(x.n)
    if x.t == 1:
        return x.s
    if x.t == 4:
        return "然" if x.b else "否"
    if x.t == 5:
        return "空"
    if x.t == 2:
        return "列「" + "、".join(书形(e) for e in x.l) + "」"
    if x.t == 3:
        return "册(" + str(len(x.d)) + "键)"
    return "诀「" + x.fname + "」"


def 整除(a, b):
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b >= 0) else -q


def 盒等(a, b):
    if a.t != b.t:
        return 然盒(False)
    if a.t == 0:
        return 然盒(a.n == b.n)
    if a.t == 1:
        return 然盒(a.s == b.s)
    if a.t == 4:
        return 然盒(a.b == b.b)
    if a.t == 5:
        return 然盒(True)
    if a.t == 6:
        return 然盒(a.fname == b.fname)
    if a.t == 2:
        if len(a.l) != len(b.l):
            return 然盒(False)
        for i in range(len(a.l)):
            if not 盒等(a.l[i], b.l[i]).b:
                return 然盒(False)
        return 然盒(True)
    if len(a.d) != len(b.d):
        return 然盒(False)
    for k in a.d:
        if k not in b.d:
            return 然盒(False)
        if not 盒等(a.d[k], b.d[k]).b:
            return 然盒(False)
    return 然盒(True)


class 评价器:
    def __init__(self, 卷名, 源行们):
        self.诀名们 = {}     # 诀名 → 诀定义节点(先呼后立:全量预注册)
        self.层 = [{}]       # 变量名 → 盒
        self.循深 = 0
        self.断标志 = False

    def 查名(self, 名):
        for i in range(len(self.层) - 1, -1, -1):
            if 名 in self.层[i]:
                return self.层[i][名]
        if 名 in self.诀名们:
            return 诀盒(self.诀名们[名])
        return None

    def 立名(self, 名, 值):
        self.层[-1][名] = 值

    def 赋名(self, 名, 值):
        # 纳于已立之名更新其绑定;未立者于当前块立之
        for i in range(len(self.层) - 1, -1, -1):
            if 名 in self.层[i]:
                self.层[i][名] = 值
                return
        self.层[-1][名] = 值

    # —— 语句 ——

    def 走句们(self, 句们, 新层):
        if 新层:
            self.层.append({})
        for 节 in 句们:
            self.走句(节)
        if 新层:
            self.层.pop()

    def 走句(self, 节):
        类 = 节["类"]
        if 类 == "声明":
            if 节["型词"] != "":
                self.立名(节["名"], 默认盒(节["型词"]))
            else:
                self.立名(节["名"], self.算(节["值"]))
            return
        if 类 == "赋值":
            self.走赋值(节)
            return
        if 类 == "输出":
            print(书形(self.算(节["值"])))
            return
        if 类 == "条件":
            for 枝 in 节["枝"]:
                if 盒真(self.算(枝["当"]), 节["行"]):
                    self.走句们(枝["体"], True)
                    return
            if 节["否则"]:
                self.走句们(节["否则"], True)
            return
        if 类 == "循环":
            if 节["当型"]:
                self.层.append({})
                self.循深 += 1
                while 盒真(self.算(节["条件"]), 节["行"]):
                    for 子 in 节["体"]:
                        self.走句(子)
                        if self.断标志:
                            break
                    if self.断标志:
                        self.断标志 = False
                        break
                self.循深 -= 1
                self.层.pop()
            else:
                列值 = 列元(self.算(节["列"]), 节["行"])
                self.层.append({})
                self.循深 += 1
                for 元 in 列值:
                    self.层[-1][节["名"]] = 元
                    for 子 in 节["体"]:
                        self.走句(子)
                        if self.断标志:
                            break
                    if self.断标志:
                        self.断标志 = False
                        break
                self.循深 -= 1
                self.层.pop()
            return
        if 类 == "止句":
            if self.循深 == 0:
                报错("文法之失", "「止」不在任何循中。", 节["行"])
            self.断标志 = True
            return
        if 类 == "故曰":
            raise 故曰值(self.算(节["值"]))
        if 类 == "受句":
            报错("文法之失", "「受」引参之句唯居于诀体之首。", 节["行"])
        if 类 == "诀定义":
            self.走诀体(节)
            return
        if 类 == "表达式语句":
            self.算(节["值"])
            return
        报错("文法之失", "未识之句类「" + 类 + "」。", 节["行"])

    def 走赋值(self, 节):
        目 = 节["目标"]
        if 目["类"] == "名":
            self.赋名(目["名"], self.算(节["值"]))
            return
        # 应用式目标
        收 = self.算(目["收"])
        实节 = 目["实"]
        if 收.t == 3:
            if 实节["类"] == "名":
                键 = 文盒(实节["名"])
            else:
                键 = self.算(实节)
            值 = self.算(节["值"])
            纳册(收, 键, 值, 节["行"])
        elif 收.t == 2:
            指 = self.算(实节)
            值 = self.算(节["值"])
            纳列(收, 指, 值, 节["行"])
        else:
            报错("异类之失", "「纳于」不可施于「" + 型名(收) + "」之受位。", 节["行"])

    def 走诀体(self, 节):
        # 诀体唯见诀名与己参(卷之变量不入诀):净化层栈
        存层 = self.层
        self.层 = [{}]
        if 节["口诀"]:
            self.层.append({})  # 规则缚名域(逐呼重建于呼时;此处仅静态走)
        else:
            pass
        self.层 = 存层

    # —— 表达式 ——

    def 算(self, 节):
        类 = 节["类"]
        if 类 == "数":
            return 数盒(int(节["值"]))
        if 类 == "文":
            return 文盒(节["值"])
        if 类 == "名":
            r = self.查名(节["名"])
            if r is None:
                报错("虚指之失", "名「" + 节["名"] + "」未立。", 节["行"])
            return r
        if 类 == "然":
            return 然盒(节["真"])
        if 类 == "空值":
            return 空盒()
        if 类 == "列值":
            return 列盒([self.算(e) for e in 节["元"]])
        if 类 == "尊名":
            行 = 节["行"]
            if 节["名"] == "问":
                return 问盒()
            if 节["名"] == "签":
                return 签盒(self.算(节["实"]), 行)
            return 度盒(self.算(节["实"]), 行)
        if 类 == "受用":
            收 = self.算(节["收"])
            实节 = 节["实"]
            行 = 节["行"]
            # 实参位裸名:收者为册则作键文,否则取变量之值(未立则虚指)
            if 实节["类"] == "名":
                if 收.t == 3:
                    实 = 文盒(实节["名"])
                else:
                    实 = self.查名(实节["名"])
                    if 实 is None:
                        报错("虚指之失", "名「" + 实节["名"] + "」未立。", 实节["行"])
            else:
                实 = self.算(实节)
            return 受盒(收, 实, 行)
        if 类 == "二元":
            行 = 节["行"]
            运 = 节["运算"]
            a = self.算(节["左"])
            b = self.算(节["右"])
            return 二元算(运, a, b, 行)
        if 类 == "一元":
            行 = 节["行"]
            子 = self.算(节["子"])
            if 节["运算"] == "非":
                return 盒非(子, 行)
            return 盒负(子, 行)
        return 空盒()

    # —— 诀呼 ——

    def 呼诀(self, 节点, 实):
        if 节点["口诀"]:
            return self.呼口诀(节点, 实)
        存层 = self.层
        self.层 = [{}]
        if 节点["参"] != "":
            self.层[0][节点["参"]] = 实
        try:
            for 子 in 节点["体"]:
                self.走句(子)
            return 空盒()
        except 故曰值 as e:
            return e.值
        finally:
            self.层 = 存层

    def 呼口诀(self, 节点, 实):
        # 缚名逐呼一域,跨规则持久(先生之缚,兜底规则亦得见——与生成码逐规则重缚同构)
        v = 实
        熔 = 0
        束总 = {}
        while True:
            熔 += 1
            if 熔 > 10000:
                报错("循环之失", "口诀「" + 节点["名"] + "」递归触发逾万次。", 节点["行"])
            中 = False
            for 规 in 节点["规则"]:
                if not self.配规则(规, v, 束总):
                    continue
                if 规["当"]["类"] != "空值":
                    self.层.append(束总)
                    try:
                        条 = self.算(规["当"])
                    finally:
                        self.层.pop()
                    if not 盒真(条, 规["行"]):
                        continue
                self.层.append(束总)
                try:
                    动 = self.算(规["动作"])
                finally:
                    self.层.pop()
                if 规["止"]:
                    return 动
                模式 = 规["模式"]
                if not 规["兜底"] and 模式["类"] == "文":
                    v = 文盒(文最左置换(v.s, 模式["值"], 书形(动)))
                else:
                    v = 动
                中 = True
                break
            if not 中:
                return v

    def 配规则(self, 规, v, 束):
        # 模式配之于束(缚名持久);字面量验之。返是否配中。
        if 规["兜底"]:
            return True
        模式 = 规["模式"]
        类 = 模式["类"]
        if 类 == "名":
            束[模式["名"]] = v
            return True
        if 类 == "数":
            return v.t == 0 and v.n == int(模式["值"])
        if 类 == "文":
            return v.t == 1 and 模式["值"] in v.s
        if 类 == "列值":
            if v.t != 2 or len(v.l) != len(模式["元"]):
                return False
            for i, 项 in enumerate(模式["元"]):
                if 项["类"] == "名":
                    束[项["名"]] = v.l[i]
                elif 项["类"] == "数":
                    if not 盒等(v.l[i], 数盒(int(项["值"]))).b:
                        return False
                elif 项["类"] == "文":
                    if not 盒等(v.l[i], 文盒(项["值"])).b:
                        return False
            return True
        return False


class 故曰值(Exception):
    def __init__(self, 值):
        self.值 = 值


def 默认盒(型词):
    if 型词 == "数":
        return 数盒(0)
    if 型词 == "文":
        return 文盒("")
    if 型词 == "列":
        return 列盒([])
    if 型词 == "册":
        return 册盒()
    if 型词 == "然否":
        return 然盒(False)
    return 空盒()


def 盒真(x, 行):
    if x.t != 4:
        报错("异类之失", "条件必为然否,今得「" + 型名(x) + "」。", 行)
    return x.b


def 二元算(运, a, b, 行):
    if 运 == "加":
        if a.t == 0 and b.t == 0:
            return 数盒(a.n + b.n)
        if a.t == 1:
            return 文盒(a.s + 书形(b))
        if a.t == 2 and b.t == 2:
            return 列盒(a.l + b.l)
        报错("异类之失", "「加」不可施于「" + 型名(a) + "」与「" + 型名(b) + "」。", 行)
    if 运 == "减":
        if a.t != 0 or b.t != 0:
            报错("异类之失", "「减」不可施于「" + 型名(a) + "」与「" + 型名(b) + "」。", 行)
        return 数盒(a.n - b.n)
    if 运 == "乘":
        if a.t != 0 or b.t != 0:
            报错("异类之失", "「乘」不可施于「" + 型名(a) + "」与「" + 型名(b) + "」。", 行)
        return 数盒(a.n * b.n)
    if 运 == "除":
        if a.t != 0 or b.t != 0:
            报错("异类之失", "「除」不可施于「" + 型名(a) + "」与「" + 型名(b) + "」。", 行)
        if b.n == 0:
            报错("零除之失", "「除」不可施于零。", 行)
        return 数盒(整除(a.n, b.n))
    if 运 == "余":
        if a.t != 0 or b.t != 0:
            报错("异类之失", "「余」不可施于「" + 型名(a) + "」与「" + 型名(b) + "」。", 行)
        if b.n == 0:
            报错("零除之失", "「余」不可施于零。", 行)
        return 数盒(a.n - 整除(a.n, b.n) * b.n)
    if 运 == "且":
        if a.t != 4 or b.t != 4:
            报错("异类之失", "「且」不可施于「" + 型名(a) + "」与「" + 型名(b) + "」。", 行)
        return 然盒(a.b and b.b)
    if 运 == "或":
        if a.t != 4 or b.t != 4:
            报错("异类之失", "「或」不可施于「" + 型名(a) + "」与「" + 型名(b) + "」。", 行)
        return 然盒(a.b or b.b)
    if 运 == "等于":
        return 盒等(a, b)
    if 运 == "小于":
        if a.t == 0 and b.t == 0:
            return 然盒(a.n < b.n)
        if a.t == 1 and b.t == 1:
            return 然盒(a.s < b.s)
        报错("异类之失", "大小比较不可施于「" + 型名(a) + "」与「" + 型名(b) + "」。", 行)
    if 运 == "大于":
        if a.t == 0 and b.t == 0:
            return 然盒(a.n > b.n)
        if a.t == 1 and b.t == 1:
            return 然盒(a.s > b.s)
        报错("异类之失", "大小比较不可施于「" + 型名(a) + "」与「" + 型名(b) + "」。", 行)
    if 运 == "不小于":
        小 = 二元算("小于", a, b, 行)
        return 盒非(小, 行)
    if 运 == "不大于":
        小 = 二元算("小于", b, a, 行)
        return 盒非(小, 行)
    # 不等于
    等 = 盒等(a, b)
    return 盒非(等, 行)


def 盒非(x, 行):
    if x.t != 4:
        报错("异类之失", "「非」不可施于「" + 型名(x) + "」。", 行)
    return 然盒(not x.b)


def 盒负(x, 行):
    if x.t != 0:
        报错("异类之失", "「负」不可施于「" + 型名(x) + "」。", 行)
    return 数盒(-x.n)


def 受盒(a, b, 行):
    if a.t == 6:
        return _评价器.呼诀(a.fn, b)
    if a.t == 3:
        if b.t != 1:
            报错("异类之失", "册键必文,今得「" + 型名(b) + "」。", 行)
        if b.s in a.d:
            return a.d[b.s]
        return 空盒()
    if a.t == 2:
        if b.t != 0:
            报错("异类之失", "列指必数,今得「" + 型名(b) + "」。", 行)
        if b.n < 1 or b.n > len(a.l):
            报错("逾界之失", "列无第" + str(b.n) + "位(共" + str(len(a.l)) + "位)。", 行)
        return a.l[b.n - 1]
    报错("异类之失", "「受」不可施于「" + 型名(a) + "」。", 行)


def 纳册(a, 键, 值, 行):
    if 键.t != 1:
        报错("异类之失", "册键必文,今得「" + 型名(键) + "」。", 行)
    a.d[键.s] = 值


def 纳列(a, 指, 值, 行):
    if 指.t != 0:
        报错("异类之失", "列指必数,今得「" + 型名(指) + "」。", 行)
    if 指.n < 1 or 指.n > len(a.l):
        报错("逾界之失", "列无第" + str(指.n) + "位(共" + str(len(a.l)) + "位)。", 行)
    a.l[指.n - 1] = 值


def 列元(a, 行):
    if a.t != 2:
        报错("异类之失", "「循于」必施于列,今得「" + 型名(a) + "」。", 行)
    return a.l


def 度盒(a, 行):
    if a.t == 1:
        return 数盒(len(a.s))
    if a.t == 2:
        return 数盒(len(a.l))
    if a.t == 3:
        return 数盒(len(a.d))
    报错("异类之失", "「度」不可施于「" + 型名(a) + "」。", 行)


def 问盒():
    行 = sys.stdin.readline()
    if 行 == "":
        return 文盒("")
    s = 行.rstrip("\n").rstrip("\r")
    if s == "":
        return 文盒("")
    if all(c in "0123456789" for c in s) and len(s) < 19:
        return 数盒(int(s))
    试 = 解数词(s)
    if 试[0]:
        return 数盒(试[1])
    return 文盒(s)


def 签盒(a, 行):
    if a.t != 0:
        报错("异类之失", "「签」必受数,今得「" + 型名(a) + "」。", 行)
    if a.n < 1:
        报错("逾界之失", "「签」受之数当不小于一,今得" + str(a.n) + "。", 行)
    return 数盒(random.randint(1, a.n))


def 文最左置换(源, 模式, 置换):
    i = 源.find(模式)
    if i < 0:
        return 源
    return 源[:i] + 置换 + 源[i + len(模式):]


评价器实例 = None


def 主():
    global _ctx, _评价器
    if len(sys.argv) < 2:
        print("用法: 解释器.py <源.jd>")
        sys.exit(1)
    路径 = sys.argv[1]
    卷名 = 路径
    for sep in ("/", "\\"):
        卷名 = 卷名.split(sep)[-1]
    if 卷名.lower().endswith(".jd"):
        卷名 = 卷名[:-3]
    try:
        源文 = open(路径, encoding="utf-8").read()
    except OSError as e:
        _ctx = 上下文(卷名, [])
        报错("文法之失", "源卷不可读(" + str(e) + ")。", 1)
    源文 = 源文.replace("\r\n", "\n").replace("\r", "\n")
    源行们 = 源文.split("\n")
    _ctx = 上下文(卷名, 源行们)
    try:
        词 = 词法器(源文, 卷名)
        标记们 = 词.全部标记()
    except 译错 as e:
        报错(e.类目, e.消息, e.行)
    法 = 语法器(标记们, 卷名)
    try:
        句们 = 法.解程序()
    except 译错 as e:
        报错(e.类目, e.消息, e.行)
    global 评价器实例
    评价器实例 = 评价器(卷名, 源行们)
    # 诀名先呼后立:全量预注册
    def 收诀名(句们):
        for 节 in 句们:
            if 节["类"] == "诀定义":
                if 节["名"] in 评价器实例.诀名们:
                    报错("文法之失", "名「" + 节["名"] + "」已立,不得重立。", 节["行"])
                评价器实例.诀名们[节["名"]] = 节
    收诀名(句们)
    # 受盒呼诀需访问评价器实例
    global _评价器
    _评价器 = 评价器实例
    try:
        评价器实例.走句们(句们, False)
    except 译错 as e:
        报错(e.类目, e.消息, e.行)


_评价器 = None

if __name__ == "__main__":
    主()
