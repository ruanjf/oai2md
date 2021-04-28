const fs = require('fs');
const path = require('path');

const yaml = require('yaml');
const converter = require('widdershins');

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
    .default('field_expansion', false)

    .string('data_unwrap')
    .alias('dw','data_unwrap')
    .describe('data_unwrap','数据解包')
    .default('data_unwrap', false)

    .boolean('multiple_files')
    .alias('mu','multiple_files')
    .describe('multiple_files','多文件输出')
    .default('multiple_files', false)

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
        console.log('finish', out)
        if (argv.multiple_files) {
            let name = {
                "Authentication": '认证',
                "Paths": 'API',
                "Schemas": '实体'
            }
            let schemas = api.components.schemas || {}
            let tree = mdTree(3, out)
            let md = [...tree.lines]
            let scm_regex = /\|(\[{1,})?\[(.*?)\]\(#(.*?)\)(\]{1,})?\|/g // 实体地址修改
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
                            let nt = child.lines.filter(s => s.startsWith('<!-- [')).map(s => s.match(/^<!-- \[(.*?)\]\((.*?)\) -->$/))[0]
                            if (nt && nt[2] !== tag[2]) {
                                tag = nt
                                if (!isSchema) {
                                    md.push('', '### ' + tag[1], '')
                                }
                            }
                            let fn = null;
                            if (isSchema) {
                                tag = nt || []
                                fn = child.head + '.md'
                                md.push(`* [${tag[1] || child.head}](./${nodeHead}/${fn})`)
                            } else {
                                fn = `${String(1000 + ++index).substring(1)}_${tag[2] || nodeHead}.md`
                                md.push(`* [${child.head}](./${nodeHead}/${fn})`)
                            }
                            let h = ['---', 'title: '+child.head, '---']
                            let cl = child.lines
                                .map(s => s.replace(/^##/, ''))
                                .map(s => s.replace(scm_regex, ($0,$1,$2,$3,$4) => {return schemas[$2] ? `|${$1||''}[${$2}](../schemas/${$2}.md)${$4||''}|` : $0;}))
                            fs.writeFileSync(path.resolve(p+'/'+fn), [...h, ...cl].join('\n'),'utf8');
                        }
                    }
                }
            }
            fs.writeFileSync(path.resolve(argv.outfile+'/index.md'), md.join('\n'),'utf8');
        }
    })
    return;
}

// 将makrkdown文件按照目录解析成树结构，level=目录层级 file=文件
function mdTree(level, file) {
    let s = fs.readFileSync(file,'utf8');

    let head_regex = /^#{1,6}/
    let lines = s.split(/\r?\n/)
    let block = root = {
        head: null,
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
                level: hd[0].length,
                start: i,
                end: null,
                lines: [],
                parent: null,
                children: []
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

const SwaggerParser = require("@apidevtools/swagger-parser");

let args = process.argv.slice(2);
let sourceUrl = args[0]
let outfile = args[1]

let options = {};
options.codeSamples = false;
options.tocSummary = true;
options.omitHeader = true;
options.sample = true;
// options.user_templates = './user_templates/openapi3';
options.user_templates = path.resolve(__dirname, 'user_templates', 'openapi3');
options.source = sourceUrl;
options.templateCallback = function(templateName,stage,data) {
    if (stage === 'pre') {
        data.utils.dashToCamel = s => {
            return s.replace(/-\w/g, m => m.substring(1).toUpperCase())
        }
        let keyTagBaseUrl = 'x-base-url';
        for (let tag of data.api.tags) {
            let tbu = tag[keyTagBaseUrl];
            if (!tbu) {
                continue;
            }
            let rs = data.resources[tag.name];
            if (!rs || !rs.methods) {
                continue;
            }
            Object.values(rs.methods).forEach(o => o.path = tbu + o.path)
        }
        let keyOldRef = 'x-widdershins-oldRef';
        // 获取参数Schema
        let contents = Object.values(data.resources)
            .flatMap(o => Object.values(o.methods))
            .flatMap(o => Object.values(o.pathItem).flatMap(v=>[v.requestBody].concat(Object.values(v.responses || {}))))
            .filter(o => !!o && o.content)
            .flatMap(o => Object.values(o.content))
            .filter(o => !!o && o.schema);
        // 去重
        contents = Array.from(new Set(contents));

        // 合并只包含allOf的Schema
        let mergeOneAllOf = o => {
            if (!o || !o.allOf || Object.keys(o).filter(o => o.endsWith('Of')).length > 1) {
                return o;
            }
            let schema = o.allOf.reduce((acc,v) => Object.assign({}, acc, v, {properties: Object.assign({}, acc.properties || {}, v.properties || {})}), {type:'object'});
            delete schema[keyOldRef]
            toRef(schema)
            if (schema.properties) {
                for (let [k, v] of Object.entries(schema.properties)) {
                    v = mergeOneAllOf(v)
                    toRef(v)
                    schema.properties[k] = v
                }
            }
            return schema;
        }
        // 引用对象属性不展开
        let toRef = o => {
            if (!o || !o.properties) {
                return;
            }
            Object.entries(o.properties).forEach(([k,v]) => {
                let ref = v[keyOldRef];
                if (ref) {
                    o.properties[k] = { '$ref': ref }
                } else if (v.type === 'array' && v.items) {
                    let r = v.items[keyOldRef]
                    if (r) {
                        v.items = { '$ref': r }
                    }
                }
            });
        }

        contents
            .forEach(o => o.schema = mergeOneAllOf(o.schema));
        contents
            .filter(o => o.schema.properties)
            .forEach(o => toRef(o.schema));
    }
    return data
};

SwaggerParser.validate(sourceUrl, (err, api) => {
    if (err) {
        console.error(err);
    } else {
        let s = fs.readFileSync(sourceUrl,'utf8');
        api = yaml.parse(s)
        converter.convert(api,options)
            .then(str => {
                // str contains the converted markdown
                let head = api['x-md-head'];
                if (head) {
                    str = `---\ntitle: ${head}\n---\n${str}`;
                }
                if (outfile) {
                    fs.writeFileSync(path.resolve(outfile), str ,'utf8');
                } else {
                    console.log(str)
                }
            })
            .catch(err => {
                console.error(err);
            });
    }
});
