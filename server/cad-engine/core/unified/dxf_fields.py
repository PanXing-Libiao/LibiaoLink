"""Bounded read-only evaluation of deterministic built-in FIELD expressions.

No eval, application callbacks, filesystem, wall clock or editing. Persisted
object references use FIELD group 331, never a runtime decimal ObjectID as a
DXF handle. Unsupported evaluators retain their source cache when present.
"""
import ast
import math
import operator
import re

MAX_DEPTH = 16
MAX_TEXT = 100000


def arithmetic(text):
    if len(text)>4096: raise ValueError('field-formula-budget')
    try: tree=ast.parse(text.replace('^','**'),mode='eval')
    except SyntaxError as error: raise ValueError('field-formula-invalid') from error
    if sum(1 for _ in ast.walk(tree))>256: raise ValueError('field-formula-budget')
    binary={ast.Add:operator.add,ast.Sub:operator.sub,ast.Mult:operator.mul,
            ast.Div:operator.truediv,ast.Mod:operator.mod,ast.Pow:operator.pow}
    def walk(node):
        if isinstance(node,ast.Constant) and type(node.value) in (int,float): result=node.value
        elif isinstance(node,ast.UnaryOp) and isinstance(node.op,(ast.UAdd,ast.USub)):
            result=walk(node.operand)*(1 if isinstance(node.op,ast.UAdd) else -1)
        elif isinstance(node,ast.BinOp) and type(node.op) in binary:
            left,right=walk(node.left),walk(node.right)
            if isinstance(node.op,ast.Pow) and abs(right)>16: raise ValueError('field-formula-exponent-budget')
            result=binary[type(node.op)](left,right)
        else: raise ValueError('field-formula-operation-unsupported')
        if not isinstance(result,(int,float)) or not math.isfinite(result) or abs(result)>1e100:
            raise ValueError('field-formula-value-invalid')
        return result
    try: return walk(tree.body)
    except (SyntaxError,ZeroDivisionError,OverflowError) as error:
        raise ValueError('field-formula-invalid') from error


def format_value(value, spec):
    if not spec: return str(value) if not isinstance(value,float) else format(value,'.12g')
    # Decimal notation, precision and explicit conversion are deterministic.
    rest=spec
    unit=re.search(r'%lu(\d+)',rest)
    if unit and unit[1]!='2': raise ValueError('field-number-unit-format-unsupported')
    rest=re.sub(r'%lu\d+','',rest)
    precision=re.search(r'%pr(\d+)',rest)
    digits=int(precision[1]) if precision else None
    if digits is not None and digits>16: raise ValueError('field-precision-out-of-range')
    rest=re.sub(r'%pr\d+','',rest)
    conversion=re.search(r'%ct8\[([+-]?[\d.eE]+)\]',rest)
    if conversion:
        value=float(value)*float(conversion[1]);rest=rest.replace(conversion[0],'')
        if not math.isfinite(value) or abs(value)>1e100:raise ValueError('field-format-conversion-invalid')
    prefix=suffix=''
    affix=re.search(r'%ps\[([^,\]]*),([^\]]*)\]',rest)
    if affix: prefix,suffix=affix[1],affix[2];rest=rest.replace(affix[0],'')
    separator=re.search(r'%ds(\d+)',rest)
    if separator: rest=rest.replace(separator[0],'')
    if rest: raise ValueError('field-format-unsupported:'+rest)
    if digits is not None:
        value=format(float(value),'.'+str(digits)+'f')
    elif isinstance(value,float): value=format(value,'.12g')
    else: value=str(value)
    if separator:
        code=int(separator[1])
        if code not in (44,46): raise ValueError('field-decimal-separator-unsupported')
        value=value.replace('.',chr(code))
    return prefix+value+suffix


def object_property(source,handle,prop):
    obj=source['objects'].get(handle)
    if obj is None: raise ValueError('field-reference-object-missing:'+handle)
    attrs=obj['attributes'];kind=obj['type']
    aliases={'layer':'layer','color':'color','linetype':'linetype','textstring':'text',
        'radius':'radius','measurement':'actual_measurement','rotation':'rotation', 'name':'name'}
    key=aliases.get(prop.lower())
    if key in attrs: return attrs[key]
    if prop.lower()=='length' and kind=='LINE': return math.dist(attrs['start'],attrs['end'])
    if prop.lower() in ('area','circumference','diameter') and kind=='CIRCLE':
        radius=attrs['radius']
        return {'area':math.pi*radius**2,'circumference':2*math.pi*radius,'diameter':2*radius}[prop.lower()]
    raise ValueError('field-object-property-unsupported:'+kind+'.'+prop)


def evaluate(code, source, fields=None, depth=0, current=None):
    if depth>MAX_DEPTH or len(code)>MAX_TEXT: raise ValueError('field-expression-budget')
    fields=fields or {}
    code=code.strip()
    if code.startswith('%<') and code.endswith('>%'): code=code[2:-2].strip()
    fmt=''
    match=re.search(r'\s+\\f\s+"([^"]*)"\s*$',code)
    if match: fmt=match[1];code=code[:match.start()].strip()
    # Child field indices are local to the containing FIELD object.
    child=re.fullmatch(r'\\_FldIdx\s+(\d+)',code)
    if child:
        index=int(child[1]);children=(current or {}).get('children',[])
        if index>=len(children) or children[index] not in fields: raise ValueError('field-child-index-missing')
        row=fields[children[index]]
        return evaluate(row['code'],source,fields,depth+1,row)
    if code.startswith('\\AcExpr '):
        expression=expand(code[8:],source,fields,depth+1,current)
        result=arithmetic(expression)
    elif code.startswith('\\AcVar '):
        name=code[7:].strip().upper()
        if not re.fullmatch(r'[A-Z][A-Z0-9_]*',name): raise ValueError('field-system-variable-invalid')
        if '$'+name not in source.get('header',{}): raise ValueError('field-system-variable-unsupported:'+name)
        result=source['header']['$'+name]
        if not isinstance(result,(str,int,float)): raise ValueError('field-system-variable-type-unsupported')
    elif code.startswith('\\AcDocProp '):
        name=code[11:].strip()
        if name.startswith('CustomDP.'): name=name[9:]
        properties=dict(source.get('customProperties',[]))
        if name not in properties: raise ValueError('field-document-property-missing:'+name)
        result=properties[name]
    elif code.startswith('\\AcObjProp'):
        match=re.fullmatch(r'\\AcObjProp(?:\.\d+(?:\.\d+)*)?\s+Object\(%<\\_ObjIdx\s+(\d+)>%\)\.([A-Za-z][A-Za-z0-9]*)',code)
        handles=[val for tag,val in (current or {}).get('tags',[]) if tag==331]
        if not match or int(match[1])>=len(handles): raise ValueError('field-object-reference-unresolved')
        result=object_property(source,handles[int(match[1])],match[2])
    else: raise ValueError('field-evaluator-unsupported')
    return format_value(result,fmt)


def expand(text, source, fields=None, depth=0, current=None):
    if depth>MAX_DEPTH or len(text)>MAX_TEXT: raise ValueError('field-expression-budget')
    result=[];offset=0
    while True:
        start=text.find('%<',offset)
        if start<0: result.append(text[offset:]);break
        end=start+2;nest=1
        while nest and end<len(text):
            if text.startswith('%<',end): nest+=1;end+=2
            elif text.startswith('>%',end): nest-=1;end+=2
            else: end+=1
            if nest>MAX_DEPTH: raise ValueError('field-expression-budget')
        if nest: raise ValueError('field-expression-unclosed')
        result.extend((text[offset:start],evaluate(text[start:end],source,fields,depth+1,current)));offset=end
    output=''.join(result)
    if len(output)>MAX_TEXT: raise ValueError('field-text-budget')
    return output
