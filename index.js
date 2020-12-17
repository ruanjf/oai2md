const fs = require('fs');
const path = require('path');

const yaml = require('yaml');
const converter = require('widdershins');
const SwaggerParser = require("@apidevtools/swagger-parser");

let args = process.argv.slice(2);
let sourceUrl = args[0]
let outfile = args[1]

let options = {};
options.codeSamples = false;
options.tocSummary = true;
options.omitHeader = true;
options.sample = true;
options.user_templates = './user_templates/openapi3';
options.source = sourceUrl;
options.templateCallback = function(templateName,stage,data) {
    if (stage === 'pre') {
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
            .flatMap(o => Object.values(o.pathItem).flatMap(v=>[v.requestBody].concat(Object.values(v.responses))))
            .filter(o => !!o)
            .flatMap(o => Object.values(o.content))
            .filter(o => !!o && o.schema);
        // 去重
        contents = Array.from(new Set(contents));

        // 合并只包含allOf的Schema
        let mergeOneAllOf = o => {
            if (!o || !o.allOf || Object.keys(o).filter(o => o.endsWith('Of')).length > 1) {
                return o;
            }
            let schema = o.allOf.reduce((acc,v) => Object.assign({}, acc, v, {properties: Object.assign({}, acc.properties, v.properties)}), {type:'object'});
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
