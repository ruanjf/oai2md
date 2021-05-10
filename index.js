const fs = require('fs');
const path = require('path');

const yaml = require('yaml');
const converter = require('widdershins');

const SwaggerParser = require("@apidevtools/swagger-parser");

var argv = require('yargs')
    .usage('oai2md [options] {input-file|url} [[-o] output markdown]')
    .demandCommand(1, '请指定API定义文件')
    .strict()

    .choices('user_templates', ['openapi3', 'of'])
    .alias('u','user_templates')
    .describe('user_templates','转换使用的模版，openapi3、of')
    .default('user_templates','of')

    .string('outfile')
    .alias('o','outfile')
    .describe('outfile','指定输出位置')

    .boolean('debug')
    .describe('debug','开启debug模式')
    .default('debug', false)

    .boolean('field_expansion')
    .alias('fe','field_expansion')
    .describe('field_expansion','数据字段展开')
    .default('field_expansion', true)

    .string('data_unwrap')
    .alias('du','data_unwrap')
    .describe('data_unwrap','数据解包，移除Msg包裹')
    .default('data_unwrap', true)

    .boolean('multiple_files')
    .alias('mu','multiple_files')
    .describe('multiple_files','多文件输出')
    .default('multiple_files', true)

    .help('h')
    .alias('h','help')
    .version()
    .argv;
if (argv.debug) {
    console.log('args', argv)
}

const converters = fs.readdirSync(path.resolve(__dirname, 'converters'), {withFileTypes: true})
    .filter(f => f.isFile() && f.name.endsWith('.js'))
    .reduce((r, f) => {
        let name = f.name.substring(0, f.name.length-3);
        r[name] = require('./converters/'+name)
        return r;
    }, {});
if (argv.debug) {
    console.log('converters', converters)
}

const cvt = converters[argv.user_templates];
if (cvt) {
    let outfile = argv.outfile
    if (argv.multiple_files) {
        outfile += '/all.md';
    }

    fs.mkdirSync(path.resolve(path.dirname(outfile)), {recursive: true})
    cvt(argv._[0], outfile, argv, (api,out) => {
        mdSplitToFiles(argv, api, out)
        console.log('finish', out)
    })
    return;
} else {
    console.log('no converter for ' + argv.user_templates)
}

// 将makrkdown文件按照目录分割成多个文件
function mdSplitToFiles(argv, api, out) {
    if (argv.multiple_files) {
        let name = {
            "Authentication": '认证',
            "Paths": 'API',
            "Schemas": '实体'
        }
        let schemas = api.components.schemas || {}
        let tree = mdTree(3, out)
        let md = [...tree.lines]
        let scm_regex = /\|([{\[]{1,})?\[([^|]*?)\]\(#([^|]*?)\)([\]}]{1,})?(\(\w+\))?\|/g // 实体地址修改
        md.push('# ' + tree.children[0].head)
        md.push(...tree.children[0].lines)
        for (let node of tree.children[0].children) {
            md.push('', '## ' + name[node.head] || node.head, '')
            if (node.children.length === 0) {
                md.push(...node.lines)
            } else {
                let isSchema = node.head === 'Schemas';
                let index = 0;
                let nodeHead = node.head.toLowerCase()
                let p = argv.outfile+'/'+nodeHead
                let tag = [];
                fs.mkdirSync(path.resolve(p), {recursive: true})
                for (let child of node.children) {
                    if (child.lines.length === 0) {
                        md.push('* ' +child.head)
                    } else {
                        let fn = null;
                        if (isSchema) {
                            fn = (child.key || child.head) + '.md'
                        } else {
                            fn = child.key ? `${child.key}.md` : `${String(1000 + ++index).substring(1)}_${tag[2] || nodeHead}.md`
                            let nt = child.lines.filter(s => s.startsWith('<!-- tag [')).map(s => s.match(/^<!-- tag \[(.*?)\]\((.*?)\) -->$/))[0]
                            if (nt && nt[2] !== tag[2]) {
                                tag = nt
                                md.push('', '### ' + tag[1], '')
                            }
                        }
                        md.push(`* [${child.head}](./${nodeHead}/${fn})`)
                        let h = ['---', 'title: '+child.head, '---']
                        let cl = child.lines
                            .map(s => s.replace(/^##/, ''))
                            .map(s => s.replace(scm_regex, ($0,$1,$2,$3,$4,$5) => {return schemas[$2] ? `|${$1||''}[${$2}](../schemas/${$2}.md)${$4||''}${$5||''}|` : $0;}))
                        fs.writeFileSync(path.resolve(p+'/'+fn), [...h, ...cl].join('\n'),'utf8');
                    }
                }
            }
        }
        fs.writeFileSync(path.resolve(argv.outfile+'/index.md'), md.join('\n'),'utf8');
    }
}

// 将makrkdown文件按照目录解析成树结构，level=目录层级 file=文件
function mdTree(level, file) {
    let s = fs.readFileSync(file,'utf8');

    let head_regex = /^#{1,6}/
    let lines = s.split(/\r?\n/)
    let block = root = {
        head: null,
        key: null,
        level: 0,
        start: 0,
        end: null,
        lines: [],
        parent: null,
        children: []
    }
    let codes = 0;
    for (var i = 0; i < lines.length; i++) {
        let line = lines[i]
        let hd = null
        if (codes % 2 === 0 && (hd = head_regex.exec(line)) !== null && hd[0].length <= level) {
            let new_block = {
                head: line.substring(hd[0].length).trim(),
                key: null,
                level: hd[0].length,
                start: i,
                end: null,
                lines: [],
                parent: null,
                children: []
            }
            let tkMatch = lines[i+1] && lines[i+1].startsWith('<!-- title_and_key [') ? lines[i+1].match(/^<!-- title_and_key \[(.*?)\]\((.*?)\) -->$/) : null
            if (tkMatch && tkMatch[1] === new_block.head) {
                new_block.key = tkMatch[2]
            }
            let node = block
            while (node && node.level >= new_block.level) { // 获取上级目录
                node = node.parent
            }
            node = node || root
            new_block.parent = node
            node.children.push(new_block)
            block.end = i
            block = new_block

        } else {
            codes += (line.match(/`{3,}/) || []).length // 排除代码块中包含#标记
            block.lines.push(line)
        }
    }
    return root;
}
