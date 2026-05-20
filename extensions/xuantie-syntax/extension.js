const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { pinyin } = require('./pinyin-pro.js');

// 忽略这些内置关键字，不把它们当作当前文件变量
const keywords = new Set([
    "设", "常", "型", "函", "造", "公", "私", "护", "承", "口",
    "若", "抑", "否", "当", "循", "遍历", "于", "断", "续", "返",
    "尝试", "捕捉", "异步", "等待", "并行", "引", "予", "接着",
    "且", "或", "非", "是", "匹配", "终", "真", "假", "空", "此",
    "整", "小数", "字", "逻", "判", "数组", "字典", "字节", "结果", "任务",
    "文件", "网络", "字符串", "数学", "时", "系统", "时间", "外", "弱", "覆", "示", "化", "解", "求", "听", "连", "执", "道", "输", "成功", "失败"
]);

// 关键字及代码片段定义
const keywordSnippets = [
    { label: "设", desc: "设 (she -> 设)", body: "设 ${1:名字} = ${2:值}" },
    { label: "常", desc: "常 (chang -> 常)", body: "常 ${1:名字} = ${2:值}" },
    { label: "示", desc: "示 (shi -> 示)", body: "示(${1:内容})" },
    { label: "型", desc: "型 (xing -> 型)", body: "型 ${1:名字} {\n\t$0\n}" },
    { label: "函", desc: "函 (han -> 函)", body: "函 ${1:名字}(${2:参数}) {\n\t$0\n}" },
    { label: "造", desc: "造 (zao -> 造)", body: "造 ${1:类型}($0)" },
    { label: "引", desc: "引 (yin -> 引)", body: "引 \"${1:路径}\" 予 ${2:别名}" },
    { label: "公", desc: "公 (gong -> 公)", body: "公 " },
    { label: "私", desc: "私 (si -> 私)", body: "私 " },
    { label: "护", desc: "护 (hu -> 护)", body: "护 " },
    { label: "承", desc: "承 (cheng -> 承)", body: "承 ${1:父类}" },
    { label: "口", desc: "口 (kou -> 口)", body: "口 ${1:名字} {\n\t$0\n}" },
    { label: "若", desc: "若 (ruo -> 若)", body: "若 ${1:条件} {\n\t$0\n}" },
    { label: "抑", desc: "抑 (yi -> 抑)", body: "抑 ${1:条件} {\n\t$0\n}" },
    { label: "否", desc: "否 (fou -> 否)", body: "否 {\n\t$0\n}" },
    { label: "当", desc: "当 (dang -> 当)", body: "当 ${1:条件} {\n\t$0\n}" },
    { label: "循", desc: "循 (xun -> 循)", body: "循 {\n\t$0\n}" },
    { label: "遍历", desc: "遍历 (bianli -> 遍历)", body: "遍历 ${1:元素} 于 ${2:容器} {\n\t$0\n}" },
    { label: "断", desc: "断 (duan -> 断)", body: "断" },
    { label: "续", desc: "续 (xu -> 续)", body: "续" },
    { label: "返", desc: "返 (fan -> 返)", body: "返 $0" },
    { label: "化", desc: "化 (hua -> 化)", body: "化(${1:对象})" },
    { label: "解", desc: "解 (jie -> 解)", body: "解(${1:字符串})" },
    { label: "求", desc: "求 (qiu -> 求)", body: "求(\"${1:URL}\")" },
    { label: "听", desc: "听 (ting -> 听)", body: "听(${1:端口}, 函(${2:参数}) {\n\t$0\n})" },
    { label: "连", desc: "连 (lian -> 连)", body: "连(\"${1:地址}\")" },
    { label: "执", desc: "执 (zhi -> 执)", body: "执(\"${1:命令}\")" },
    { label: "道", desc: "道 (dao -> 道)", body: "道" },
    { label: "异步", desc: "异步 (yibu -> 异步)", body: "异步 {\n\t$0\n}" },
    { label: "等待", desc: "等待 (dd -> 等待)", body: "等待(${1:任务})" },
    { label: "并行", desc: "并行 (bx -> 并行)", body: "并行 {\n\t{ $1 },\n\t{ $0 }\n}" },
    { label: "尝试", desc: "尝试 (cs -> 尝试)", body: "尝试 {\n\t$1\n} 捕捉 (${2:错误}) {\n\t$0\n}" },
    { label: "捕捉", desc: "捕捉 (bz -> 捕捉)", body: "捕捉" },
    { label: "成功", desc: "成功 (cg -> 成功)", body: "成功(${1:值})" },
    { label: "失败", desc: "失败 (sb -> 失败)", body: "失败(${1:错误})" },
    { label: "真", desc: "真 (z -> 真)", body: "真" },
    { label: "假", desc: "假 (j -> 假)", body: "假" },
    { label: "空", desc: "空 (k -> 空)", body: "空" },
    { label: "整", desc: "整 (zs -> 整)", body: "整" },
    { label: "小数", desc: "小数 (xs -> 小数)", body: "小数" },
    { label: "字", desc: "字 (zi -> 字)", body: "字" },
    { label: "逻", desc: "逻 (l -> 逻)", body: "逻" },
    { label: "数组", desc: "数组 (sz -> 数组)", body: "数组" },
    { label: "字典", desc: "字典 (zd -> 字典)", body: "字典" },
    { label: "字节", desc: "字节 (zj -> 字节)", body: "字节" },
    { label: "结果", desc: "结果 (jg -> 结果)", body: "结果" },
    { label: "任务", desc: "任务 (rw -> 任务)", body: "任务" },
    { label: "判", desc: "判 (pan -> 判)", body: "判" },
    { label: "弱", desc: "弱 (ruo -> 弱)", body: "弱 " },
    { label: "此", desc: "此 (ci -> 此)", body: "此" },
    { label: "覆", desc: "覆 (fu -> 覆)", body: "覆 " },
    { label: "匹配", desc: "匹配 (pp -> 匹配)", body: "匹配 ${1:表达式} {\n\t${2:模式} -> {\n\t\t$0\n\t}\n}" },
    { label: "终", desc: "终 (zhong -> 终)", body: "终" },
    { label: "输", desc: "输 (shu -> 输)", body: "输(\"${1:提示}\")" },
    { label: "外", desc: "外 (wai -> 外)", body: "外 " }
];

// 预先处理关键字项 (片段模式)
const keywordCompletionItemsWithSnippets = keywordSnippets.map(ks => {
    const item = new vscode.CompletionItem(ks.label, vscode.CompletionItemKind.Snippet);
    item.insertText = new vscode.SnippetString(ks.body);
    item.detail = ks.desc;
    
    try {
        const pyArray = pinyin(ks.label, { toneType: 'none', type: 'array' });
        const fullPinyin = pyArray.join('');
        const firstLetters = pyArray.map(p => p[0]).join('');
        item.filterText = `${fullPinyin} ${firstLetters} ${ks.label}`;
    } catch (e) {
        item.filterText = ks.label;
    }
    return item;
});

// 预先处理关键字项 (纯关键字模式)
const keywordCompletionItemsOnly = keywordSnippets.map(ks => {
    const item = new vscode.CompletionItem(ks.label, vscode.CompletionItemKind.Keyword);
    item.insertText = ks.label;
    item.detail = `关键字: ${ks.label}`;
    
    try {
        const pyArray = pinyin(ks.label, { toneType: 'none', type: 'array' });
        const fullPinyin = pyArray.join('');
        const firstLetters = pyArray.map(p => p[0]).join('');
        item.filterText = `${fullPinyin} ${firstLetters} ${ks.label}`;
    } catch (e) {
        item.filterText = ks.label;
    }
    return item;
});

function getBlock(text, startIndex) {
    let braceCount = 1;
    let i = startIndex + 1;
    while (i < text.length && braceCount > 0) {
        if (text[i] === '{') braceCount++;
        else if (text[i] === '}') braceCount--;
        i++;
    }
    return text.substring(startIndex + 1, i - 1);
}

function stripBlocks(text) {
    let result = '';
    let braceCount = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '{') {
            braceCount++;
            result += ' ';
        } else if (text[i] === '}') {
            if (braceCount > 0) braceCount--;
            result += ' ';
        } else {
            if (braceCount === 0) result += text[i];
            else result += ' ';
        }
    }
    return result;
}

function analyzeCode(text, documentUri = null) {
    const typeDefs = new Map(); 
    const funcDefs = new Map();
    const varDefs = new Map();
    const symbolRanges = new Map(); // 新增：记录符号的位置信息

    // 注意：替换字符串内容或注释时，必须保持原有的字符长度，否则 match.index 无法对应回原始文本！
    let cleanText = text.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, match => ' '.repeat(match.length));
    cleanText = cleanText.replace(/\/\/.*$/gm, match => ' '.repeat(match.length));
    const cleanTextOriginal = cleanText;

    // 辅助函数：根据字符索引获取 vscode.Range
    function getRangeFromIndex(index, word) {
        if (!documentUri) return null;
        // 注意：不同操作系统的换行符不同，\r\n 会导致长度计算偏差，这里需要处理
        const textBefore = text.substring(0, index);
        const lines = textBefore.split(/\r?\n/);
        const line = lines.length - 1;
        const char = lines[line].length;
        return new vscode.Range(line, char, line, char + word.length);
    }

    const typeRegex = /型\s+([a-zA-Z_\u4e00-\u9fa50-9]+)\s*\{/g;
    let match;
    while ((match = typeRegex.exec(cleanText)) !== null) {
        const typeName = match[1];
        const typeIndex = match.index + match[0].indexOf(typeName);
        if (documentUri) {
            symbolRanges.set(typeName, { uri: documentUri, range: getRangeFromIndex(typeIndex, typeName), kind: vscode.SymbolKind.Class });
        }
        const blockStart = match.index + match[0].length - 1;
        const typeBody = getBlock(cleanText, blockStart);
        
        const methods = new Map();
        const properties = new Set();
        
        const classLevelText = stripBlocks(typeBody);
        const classVarRegex = /(?:设|常)\s+([a-zA-Z_\u4e00-\u9fa50-9]+)/g;
        let cvMatch;
        while ((cvMatch = classVarRegex.exec(classLevelText)) !== null) {
            const propName = cvMatch[1];
            properties.add(propName);
            if (documentUri) {
                const propIndex = blockStart + 1 + cvMatch.index + cvMatch[0].indexOf(propName);
                symbolRanges.set(`${typeName}.${propName}`, { uri: documentUri, range: getRangeFromIndex(propIndex, propName), kind: vscode.SymbolKind.Property });
            }
        }
        
        const methodRegex = /函\s+([a-zA-Z_\u4e00-\u9fa50-9]+)[^{]*\{/g;
        let mMatch;
        while ((mMatch = methodRegex.exec(typeBody)) !== null) {
            const methodName = mMatch[1];
            const mBlockStart = mMatch.index + mMatch[0].length - 1;
            const methodBody = getBlock(typeBody, mBlockStart);
            
            if (documentUri) {
                const methodIndex = blockStart + 1 + mMatch.index + mMatch[0].indexOf(methodName);
                symbolRanges.set(`${typeName}.${methodName}`, { uri: documentUri, range: getRangeFromIndex(methodIndex, methodName), kind: vscode.SymbolKind.Method });
            }

            const returnExprs = new Set();
            const returnRegex = /返\s+([^}\n]+)/g;
            let rMatch;
            while ((rMatch = returnRegex.exec(methodBody)) !== null) {
                returnExprs.add(rMatch[1].trim());
            }
            
            methods.set(methodName, { returnExprs, resolvedTypes: new Set() });
            
            const propRegex = /此\.([a-zA-Z_\u4e00-\u9fa50-9]+)/g;
            let pMatch;
            while ((pMatch = propRegex.exec(methodBody)) !== null) {
                properties.add(pMatch[1]);
            }
        }
        
        typeDefs.set(typeName, { methods, properties });
        
        const mask = ' '.repeat(typeBody.length + 2);
        cleanText = cleanText.substring(0, blockStart) + mask + cleanText.substring(blockStart + typeBody.length + 2);
    }

    const funcRegex = /函\s+([a-zA-Z_\u4e00-\u9fa50-9]+)[^{]*\{/g;
    while ((match = funcRegex.exec(cleanText)) !== null) {
        const funcName = match[1];
        if (documentUri) {
            const funcIndex = match.index + match[0].indexOf(funcName);
            symbolRanges.set(funcName, { uri: documentUri, range: getRangeFromIndex(funcIndex, funcName), kind: vscode.SymbolKind.Function });
        }
        const blockStart = match.index + match[0].length - 1;
        const funcBody = getBlock(cleanText, blockStart);
        
        const returnExprs = new Set();
        const returnRegex = /返\s+([^}\n]+)/g;
        let rMatch;
        while ((rMatch = returnRegex.exec(funcBody)) !== null) {
            returnExprs.add(rMatch[1].trim());
        }
        
        funcDefs.set(funcName, { returnExprs, resolvedTypes: new Set() });
    }

    function resolveTypes(exprs, localVars) {
        const types = new Set();
        for (const expr of exprs) {
            const zaoMatch = /造\s+([a-zA-Z_\u4e00-\u9fa50-9]+)/.exec(expr);
            if (zaoMatch) {
                types.add(zaoMatch[1]);
                continue;
            }
            
            const methodMatch = /([a-zA-Z_\u4e00-\u9fa50-9]+)\.([a-zA-Z_\u4e00-\u9fa50-9]+)\s*\(/.exec(expr);
            if (methodMatch) {
                const varName = methodMatch[1];
                const methodName = methodMatch[2];
                const varTypes = localVars.get(varName) || new Set();
                for (const vt of varTypes) {
                    const typeDef = typeDefs.get(vt);
                    if (typeDef && typeDef.methods.has(methodName)) {
                        const retTypes = typeDef.methods.get(methodName).resolvedTypes;
                        if (retTypes) retTypes.forEach(t => types.add(t));
                    }
                }
                continue;
            }
            
            const funcMatch = /([a-zA-Z_\u4e00-\u9fa50-9]+)\s*\(/.exec(expr);
            if (funcMatch) {
                const funcName = funcMatch[1];
                const funcDef = funcDefs.get(funcName);
                if (funcDef && funcDef.resolvedTypes) {
                    funcDef.resolvedTypes.forEach(t => types.add(t));
                }
                continue;
            }
            
            const varMatch = /^([a-zA-Z_\u4e00-\u9fa50-9]+)$/.exec(expr);
            if (varMatch) {
                const vName = varMatch[1];
                const vTypes = localVars.get(vName);
                if (vTypes) vTypes.forEach(t => types.add(t));
                continue;
            }
        }
        return types;
    }

    let changed = true;
    let iterations = 0;
    while (changed && iterations < 10) {
        changed = false;
        iterations++;
        
        for (const [funcName, funcDef] of funcDefs.entries()) {
            const oldSize = funcDef.resolvedTypes.size;
            const newTypes = resolveTypes(funcDef.returnExprs, new Map());
            newTypes.forEach(t => funcDef.resolvedTypes.add(t));
            if (funcDef.resolvedTypes.size > oldSize) changed = true;
        }
        
        for (const [typeName, typeDef] of typeDefs.entries()) {
            for (const [methodName, methodDef] of typeDef.methods.entries()) {
                const oldSize = methodDef.resolvedTypes.size;
                const newTypes = resolveTypes(methodDef.returnExprs, new Map());
                newTypes.forEach(t => methodDef.resolvedTypes.add(t));
                if (methodDef.resolvedTypes.size > oldSize) changed = true;
            }
        }
    }

    // 右侧只允许空格或制表符，避免跨过空行把下一条赋值吞进去。
    const assignRegex = /(?:设|常)?\s*([a-zA-Z_\u4e00-\u9fa50-9]+)\s*=[ \t]*([^;\n]+)/g;
    let aMatch;
    while ((aMatch = assignRegex.exec(cleanTextOriginal)) !== null) {
        const varName = aMatch[1];
        const expr = aMatch[2].trim();
        
        const types = resolveTypes([expr], varDefs);
        if (types.size > 0) {
            if (!varDefs.has(varName)) varDefs.set(varName, new Set());
            types.forEach(t => varDefs.get(varName).add(t));
        }
    }

    const topLevelText = stripBlocks(cleanTextOriginal);
    const globalSymbols = new Set();
    
    for (const t of typeDefs.keys()) globalSymbols.add(t);
    for (const f of funcDefs.keys()) globalSymbols.add(f);
    
    const globalVarRegex = /(?:设|常)\s+([a-zA-Z_\u4e00-\u9fa50-9]+)/g;
    let gvMatch;
    while ((gvMatch = globalVarRegex.exec(topLevelText)) !== null) {
        const varName = gvMatch[1];
        globalSymbols.add(varName);
        if (documentUri) {
            const varIndex = gvMatch.index + gvMatch[0].indexOf(varName);
            symbolRanges.set(varName, { uri: documentUri, range: getRangeFromIndex(varIndex, varName), kind: vscode.SymbolKind.Variable });
        }
    }

    return { typeDefs, funcDefs, varDefs, globalSymbols, symbolRanges };
}

function activate(context) {
    console.log('XuanTie extension is now active!');

    const provider = vscode.languages.registerCompletionItemProvider(
        'xuantie',
        {
            provideCompletionItems(document, position, token, context) {
                const linePrefix = document.lineAt(position).text.substr(0, position.character);

                // 检查是否在 `引 "..."` 中进行路径补全
                const importMatch = linePrefix.match(/引\s+"([^"]*)$/);
                if (importMatch) {
                    const typedPath = importMatch[1];
                    const currentDir = path.dirname(document.uri.fsPath);
                    let searchDir = currentDir;
                    
                    if (typedPath.includes('/')) {
                        const lastSlashIndex = typedPath.lastIndexOf('/');
                        const dirPart = typedPath.substring(0, lastSlashIndex);
                        if (dirPart !== "") {
                            searchDir = path.resolve(currentDir, dirPart);
                        } else {
                            searchDir = path.resolve(currentDir, '/');
                        }
                    }

                    const pathItems = [];
                    try {
                        if (fs.existsSync(searchDir) && fs.statSync(searchDir).isDirectory()) {
                            const files = fs.readdirSync(searchDir);
                            for (const file of files) {
                                const fullPath = path.join(searchDir, file);
                                let isDir = false;
                                try {
                                    isDir = fs.statSync(fullPath).isDirectory();
                                } catch(e) {}
                                
                                if (isDir || file.endsWith('.xt')) {
                                    const kind = isDir ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File;
                                    const item = new vscode.CompletionItem(file, kind);
                                    item.insertText = isDir ? file + '/' : file;
                                    item.sortText = isDir ? '0' + file : '1' + file;
                                    pathItems.push(item);
                                }
                            }
                        }
                    } catch (e) {
                        console.error('Path completion error:', e);
                    }
                    return pathItems;
                }

                let text = document.getText();
                const currentFilePath = document.uri.fsPath;
                
                const visited = new Set();
                visited.add(path.normalize(currentFilePath).toLowerCase());

                const importedTexts = [];
                
                function parseImports(content, currentDir) {
                    const importRegex = /引\s+"([^"]+)"/g;
                    let importMatch;
                    
                    while ((importMatch = importRegex.exec(content)) !== null) {
                        const importPath = importMatch[1];
                        try {
                            let absolutePath = path.resolve(currentDir, importPath);
                            if (!absolutePath.endsWith('.xt')) {
                                absolutePath += '.xt';
                            }
                            
                            const normalizedPath = path.normalize(absolutePath).toLowerCase();
                            
                            if (!visited.has(normalizedPath)) {
                                visited.add(normalizedPath);
                                if (fs.existsSync(absolutePath)) {
                                    const importedText = fs.readFileSync(absolutePath, 'utf-8');
                                    importedTexts.push(importedText);
                                    parseImports(importedText, path.dirname(absolutePath));
                                }
                            }
                        } catch (err) {
                            console.error('Failed to read imported file:', err);
                        }
                    }
                }

                parseImports(text, path.dirname(currentFilePath));
                
                let processText = importedTexts.join('\n\n') + '\n\n' + text;
                const analysis = analyzeCode(processText);

                const propMatch = linePrefix.match(/([a-zA-Z_\u4e00-\u9fa50-9]+)\.\s*([a-zA-Z0-9_\u4e00-\u9fa5]*\??)$/);

                const completionItems = [];

                if (propMatch) {
                    const varName = propMatch[1];
                    let varTypes = null;

                    if (varName === '此') {
                        const textBeforeCursor = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
                        let cleanBefore = textBeforeCursor.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""').replace(/\/\/.*$/gm, '');
                        const typeRegex = /型\s+([a-zA-Z_\u4e00-\u9fa50-9]+)[^{]*\{/g;
                        let tMatch;
                        let currentType = null;
                        while ((tMatch = typeRegex.exec(cleanBefore)) !== null) {
                            const blockStart = tMatch.index + tMatch[0].length;
                            const textAfterType = cleanBefore.substring(blockStart);
                            const openBraces = (textAfterType.match(/\{/g) || []).length;
                            const closeBraces = (textAfterType.match(/\}/g) || []).length;
                            if (openBraces >= closeBraces) {
                                currentType = tMatch[1];
                            }
                        }
                        if (currentType) {
                            varTypes = new Set([currentType]);
                        }
                    } else {
                        varTypes = analysis.varDefs.get(varName) || (analysis.typeDefs.has(varName) ? new Set([varName]) : null);
                    }
                    
                    if (varTypes && varTypes.size > 0) {
                        for (const typeName of varTypes) {
                            const typeDef = analysis.typeDefs.get(typeName);
                            if (typeDef) {
                                const addPinyinItem = (name, kind, detail) => {
                                    const item = new vscode.CompletionItem(name, kind);
                                    item.detail = detail;
                                    try {
                                        if (/[\u4e00-\u9fa5]/.test(name)) {
                                            const pyArray = pinyin(name, { toneType: 'none', type: 'array' });
                                            item.filterText = `${pyArray.join('')} ${pyArray.map(p=>p[0]).join('')} ${name}`;
                                        } else {
                                            item.filterText = name;
                                        }
                                    } catch(e) { item.filterText = name; }
                                    completionItems.push(item);
                                };
                                
                                for (const methodName of typeDef.methods.keys()) {
                                    addPinyinItem(methodName, vscode.CompletionItemKind.Method, `${typeName} 方法: ${methodName}`);
                                }
                                for (const propName of typeDef.properties) {
                                    addPinyinItem(propName, vscode.CompletionItemKind.Property, `${typeName} 属性: ${propName}`);
                                }
                            }
                        }
                    }
                    return completionItems;
                }

                const enableSnippets = vscode.workspace.getConfiguration('xuantie').get('enableSnippets', false);
                const keywordItems = enableSnippets ? keywordCompletionItemsWithSnippets : keywordCompletionItemsOnly;
                completionItems.push(...keywordItems);

                const cleanCurrentText = text.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""').replace(/\/\/.*$/gm, '');
                const localWords = new Set();
                const wordRegex = /([a-zA-Z_\u4e00-\u9fa5][a-zA-Z0-9_\u4e00-\u9fa5]*\??)/g;
                let wMatch;
                while ((wMatch = wordRegex.exec(cleanCurrentText)) !== null) {
                    localWords.add(wMatch[1]);
                }

                const targetWords = new Set([...analysis.globalSymbols, ...localWords]);
                for (const kw of keywords) {
                    targetWords.delete(kw);
                }

                for (const word of targetWords) {
                    const item = new vscode.CompletionItem(word, vscode.CompletionItemKind.Variable);
                    item.detail = analysis.globalSymbols.has(word) && !localWords.has(word) ? `全局符号: ${word}` : `当前文件: ${word}`;
                    try {
                        if (/[\u4e00-\u9fa5]/.test(word)) {
                            const pyArray = pinyin(word, { toneType: 'none', type: 'array' });
                            item.filterText = `${pyArray.join('')} ${pyArray.map(p=>p[0]).join('')} ${word}`;
                        } else {
                            item.filterText = word;
                        }
                    } catch(e) { item.filterText = word; }
                    completionItems.push(item);
                }

                return completionItems;
            }
        },
        '.', '/', '"'
    );

    // 注册 DocumentSymbolProvider (Ctrl+Shift+O)
    const symbolProvider = vscode.languages.registerDocumentSymbolProvider(
        'xuantie',
        {
            provideDocumentSymbols(document, token) {
                const analysis = analyzeCode(document.getText(), document.uri);
                const symbols = [];
                
                for (const [name, info] of analysis.symbolRanges.entries()) {
                    // 如果名字包含点号（如 "铁数帧.展示"），则作为类的子符号（简化处理，这里全部平铺展示，图标区分即可）
                    const shortName = name.includes('.') ? name.split('.')[1] : name;
                    const containerName = name.includes('.') ? name.split('.')[0] : '';
                    
                    const symbol = new vscode.DocumentSymbol(
                        shortName,
                        containerName,
                        info.kind,
                        info.range,
                        info.range
                    );
                    symbols.push(symbol);
                }
                return symbols;
            }
        }
    );

    // 注册 DefinitionProvider (Ctrl+Click 跳转)
    const definitionProvider = vscode.languages.registerDefinitionProvider(
        'xuantie',
        {
            provideDefinition(document, position, token) {
                const range = document.getWordRangeAtPosition(position, /[a-zA-Z_\u4e00-\u9fa50-9]+/);
                if (!range) return null;
                
                const word = document.getText(range);
                
                // 重新解析整个上下文（包含引用的文件）以找到定义
                const currentFilePath = document.uri.fsPath;
                const visited = new Set();
                visited.add(path.normalize(currentFilePath).toLowerCase());
                const importedFiles = new Map(); // filepath -> text
                
                function parseImportsForDef(content, currentDir) {
                    const importRegex = /引\s+"([^"]+)"/g;
                    let importMatch;
                    while ((importMatch = importRegex.exec(content)) !== null) {
                        const importPath = importMatch[1];
                        try {
                            let absolutePath = path.resolve(currentDir, importPath);
                            if (!absolutePath.endsWith('.xt')) absolutePath += '.xt';
                            const normalizedPath = path.normalize(absolutePath).toLowerCase();
                            if (!visited.has(normalizedPath)) {
                                visited.add(normalizedPath);
                                if (fs.existsSync(absolutePath)) {
                                    const importedText = fs.readFileSync(absolutePath, 'utf-8');
                                    importedFiles.set(absolutePath, importedText);
                                    parseImportsForDef(importedText, path.dirname(absolutePath));
                                }
                            }
                        } catch (err) {}
                    }
                }
                
                const currentText = document.getText();
                parseImportsForDef(currentText, path.dirname(currentFilePath));
                
                // 1. 先在当前文件中查找
                const currentAnalysis = analyzeCode(currentText, document.uri);
                
                // 检查是否是方法调用 df.展示
                const linePrefix = document.lineAt(position).text.substr(0, range.start.character);
                const propMatch = linePrefix.match(/([a-zA-Z_\u4e00-\u9fa50-9]+)\.\s*$/);
                
                if (propMatch) {
                    // 这是在点号后面的属性/方法，我们需要先推断前面的变量类型
                    const varName = propMatch[1];
                    // 合并所有文件进行类型推断
                    let processText = Array.from(importedFiles.values()).join('\n\n') + '\n\n' + currentText;
                    const fullAnalysis = analyzeCode(processText);
                    
                    let varTypes = null;
                    if (varName === '此') {
                        // 推导此
                        let cleanBefore = currentText.substring(0, document.offsetAt(position)).replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""').replace(/\/\/.*$/gm, '');
                        const typeRegex = /型\s+([a-zA-Z_\u4e00-\u9fa50-9]+)[^{]*\{/g;
                        let tMatch, currentType = null;
                        while ((tMatch = typeRegex.exec(cleanBefore)) !== null) {
                            const blockStart = tMatch.index + tMatch[0].length;
                            const textAfterType = cleanBefore.substring(blockStart);
                            if ((textAfterType.match(/\{/g) || []).length >= (textAfterType.match(/\}/g) || []).length) {
                                currentType = tMatch[1];
                            }
                        }
                        if (currentType) varTypes = new Set([currentType]);
                    } else {
                        varTypes = fullAnalysis.varDefs.get(varName) || (fullAnalysis.typeDefs.has(varName) ? new Set([varName]) : null);
                    }
                    
                    if (varTypes && varTypes.size > 0) {
                        for (const typeName of varTypes) {
                            const targetSymbolName = `${typeName}.${word}`;
                            // 查找当前文件
                            if (currentAnalysis.symbolRanges.has(targetSymbolName)) {
                                const info = currentAnalysis.symbolRanges.get(targetSymbolName);
                                return new vscode.Location(info.uri, info.range);
                            }
                            // 查找引用文件
                            for (const [filePath, text] of importedFiles.entries()) {
                                const uri = vscode.Uri.file(filePath);
                                const importAnalysis = analyzeCode(text, uri);
                                if (importAnalysis.symbolRanges.has(targetSymbolName)) {
                                    const info = importAnalysis.symbolRanges.get(targetSymbolName);
                                    return new vscode.Location(info.uri, info.range);
                                }
                            }
                        }
                    }
                } else {
                    // 全局变量、函数、类名跳转
                    if (currentAnalysis.symbolRanges.has(word)) {
                        const info = currentAnalysis.symbolRanges.get(word);
                        return new vscode.Location(info.uri, info.range);
                    }
                    
                    for (const [filePath, text] of importedFiles.entries()) {
                        const uri = vscode.Uri.file(filePath);
                        const importAnalysis = analyzeCode(text, uri);
                        if (importAnalysis.symbolRanges.has(word)) {
                            const info = importAnalysis.symbolRanges.get(word);
                            return new vscode.Location(info.uri, info.range);
                        }
                    }
                }

                return null;
            }
        }
    );

    context.subscriptions.push(provider, symbolProvider, definitionProvider);
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};
