const fs = require('fs');
const path = require('path');

const yaml = require('yaml');
const converter = require('widdershins');

const SwaggerParser = require("@apidevtools/swagger-parser");

module.exports = function(input, outfile, argv, doFinish) {
    let sourceUrl = input

    let options = {};
    options.codeSamples = false;
    options.tocSummary = true;
    options.omitHeader = true;
    options.sample = true;
    options.user_templates = path.resolve(__dirname, '..', 'user_templates', 'of');
    options.source = sourceUrl;
    options.templateCallback = function(templateName,stage,data) {
        if (stage === 'pre') {
            // 横杠命名转驼峰
            data.utils.dashToCamel = s => {
                return s.replace(/-\w/g, m => m.substring(1).toUpperCase())
            }
            // 移除返回值包裹
            data.utils.unWrapMsgSchema = schema => {
                if (argv.data_unwrap && schema['x-md-is-msg-wrap']) {
                    return schema.properties['data']
                }
                return schema;
            }
            // 拼接多级属性名称
            data.utils.schemaDotDisplayName = (schema, parent) => {
                if (parent) {
                    let pn = parent['x-display-name'];
                    let name = schema['x-name']
                    schema['x-display-name'] = pn ? (pn + '.' + name) : name
                } else {
                    delete schema['x-display-name'];
                    delete schema['x-name'];
                }

                if (schema.type === 'object') {
                    if (schema.properties) {
                        for (let [k,v] of Object.entries(schema.properties)) {
                            v['x-name'] = k
                            data.utils.schemaDotDisplayName(v, schema)
                        }
                    } else if (schema.additionalProperties) {
                        let dn = (schema['x-display-name'] || '')
                        if (schema.additionalProperties.type === 'object') {
                            dn += '{}'
                        } else if (schema.additionalProperties.type === 'array') {
                            dn += '[]'
                        }
                        schema.additionalProperties['x-name'] = dn
                        schema.additionalProperties['x-type-map'] = true
                        data.utils.schemaDotDisplayName(schema.additionalProperties, {})
                        if (parent) {
                            schema.additionalProperties['x-display-name'] = schema['x-display-name']
                        } else {
                            schema.additionalProperties['x-display-name'] = '*'+data.translations.anonymous+'*'
                        }
                    }
                } else if (schema.type === 'array' && schema.items) {
                    schema.items['x-name'] = (schema['x-display-name'] || '') + '[]'
                    data.utils.schemaDotDisplayName(schema.items, {})
                    if (!parent) {
                        delete schema.items['x-display-name']
                    }
                }
                return schema;
            }
            // 展开请求的Query参数
            data.utils.queryParameterExplode = data => {
                let ins = ['query', 'body']
                return data.parameters
                    .flatMap(p => {
                        if (p.schema && p.schema.type === 'object' && ins.indexOf(p.in) > -1) {
                            let blocks = data.utils.schemaToArray(data.utils.schemaDotDisplayName(p.schema),0,{trim:true,join:true},data)
                            let rows = blocks[0] ? blocks[0].rows : []
                            for (let o of rows) {
                                o.in = p.in
                                o.shortDesc = o.description
                                if (o['x-display-name']) {
                                    o.name = o['x-display-name']
                                }
                            }
                            return rows;
                        }
                        return [p]
                    })
            }
            // 移除重复多级属性map字段
            data.utils.filterSchemaArrayMapProp = blocks => {
                for (let block of blocks) {
                    if (!block.rows) {
                        continue
                    }
                    block.rows = block.rows.filter((v,i) => {
                        if (v.depth === 1 && v.schema.type === 'object' && v.schema.additionalProperties) {
                            let n = block.rows[i+1]
                            if (n && n.depth === 2 && n.schema['x-type-map'] 
                                    && (n.schema === v.schema.additionalProperties || n.schema['x-display-name'] === v.schema.additionalProperties['x-display-name'])) {
                                return false;
                            }
                        }
                        return true;
                    })
                }
                return blocks;
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
            let tmp_cs = contents.map(o => o.schema)
            let schemasForComp = Object.entries(data.api.components.schemas)
                .filter(([k,v]) => tmp_cs.indexOf(v) < 0)

            // 引用对象属性不展开
            let toRef = o => {
                if (!o || !o.properties || argv.field_expansion) {
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
            // 合并只包含allOf的Schema
            let mergeOneAllOf = o => {
                if (!o) {
                    return o;
                }
                if (o.type === 'array' && o.items) {
                    let ref = o.items[keyOldRef];
                    o.items = mergeOneAllOf(o.items);
                    if (ref) {
                        o.items[keyOldRef] = ref
                    }
                    return o;
                }
                let schema;
                if (o.allOf && Object.keys(o).filter(o => o.endsWith('Of')).length === 1) {
                    schema = o.allOf
                        .map(o => o.$ref ? data.components.schemas[o.$ref.replace('#/components/schemas/','')] : o)
                        .filter(o => o != null)
                        .reduce((acc,v) => Object.assign({}, acc, v, {properties: Object.assign({}, acc.properties || {}, v.properties || {})}), {type:'object'});
                    if (o.allOf[0] && o.allOf[0][keyOldRef] === '#/components/schemas/Msg') {
                        schema['x-md-is-msg-wrap'] = true
                    }
                    delete schema['description']
                    delete schema['$ref']
                    delete schema[keyOldRef]
                    if (o.description) {
                        schema.description = o.description;
                    }
                    if (o.$ref) {
                        schema.$ref = o.$ref
                    }
                    if (o[keyOldRef]) {
                        schema[keyOldRef] = o[keyOldRef]
                    }
                } else {
                    schema = o;
                }
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

            contents
                .forEach(o => o.schema = mergeOneAllOf(o.schema));
            contents
                .filter(o => o.schema.properties)
                .forEach(o => toRef(o.schema));
            schemasForComp.forEach(([k,v]) => data.api.components.schemas[k] = mergeOneAllOf(v));
            Object.values(data.api.components.schemas)
                .filter(o => o.properties)
                .forEach(o => toRef(o));
        }
        return data
    };

    return SwaggerParser.validate(sourceUrl, (err, api) => {
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
                        let out = path.resolve(outfile);
                        fs.writeFileSync(out, str ,'utf8');
                        doFinish(api, out)
                    } else {
                        console.log(str)
                    }
                })
                .catch(err => {
                    console.error(err);
                });
        }
    });

}
