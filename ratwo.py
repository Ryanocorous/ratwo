import asyncio,inspect,json,math,os,re,sys,time,uuid
from pathlib import Path
_W=re.compile(r"[a-z0-9_]+")
def _w(s):return _W.findall(str(s).lower())
def _c(s,n=120):s=" ".join(str(s or"").split());return s if len(s)<=n else s[:n-1].rsplit(" ",1)[0]+"…"
def _st(s):return" ".join(str(v)for k,x in(s or{}).get("properties",{}).items()for v in(k,x.get("description",""),*(x.get("enum",[])or[])))
def _d(x):return f"{x.get('id','')} {x.get('name','')} {x.get('description','')} {_st(x.get('inputSchema'))}"
def _g(s,p):return s.startswith(p[:-1])if p.endswith("*")else s==p
async def _m(v):return await v if inspect.isawaitable(v)else v
def _cs(a,b):
 if not a or not b:return 0.0
 n=min(len(a),len(b));d=sum(a[i]*b[i]for i in range(n));x=sum(a[i]*a[i]for i in range(n));y=sum(b[i]*b[i]for i in range(n))
 return d/math.sqrt(x*y)if x and y else 0.0
def _ch(v,s,p="$"):
 if not isinstance(s,dict):return
 if"enum"in s and v not in s["enum"]:raise ValueError(f"{p}: invalid enum")
 t=s.get("type");o={"object":lambda:isinstance(v,dict),"array":lambda:isinstance(v,list),"string":lambda:isinstance(v,str),"number":lambda:isinstance(v,(int,float))and not isinstance(v,bool),"integer":lambda:isinstance(v,int)and not isinstance(v,bool),"boolean":lambda:isinstance(v,bool),"null":lambda:v is None}
 if t in o and not o[t]():raise TypeError(f"{p}: expected {t}")
 if t=="object":
  for k in s.get("required",[]):
   if k not in v:raise ValueError(f"{p}.{k}: required")
  for k,x in s.get("properties",{}).items():
   if k in v:_ch(v[k],x,f"{p}.{k}")
 if t=="array":
  for i,x in enumerate(v):_ch(x,s.get("items"),f"{p}[{i}]")
def _b(I,q,k=5):
 q=_w(q)
 if not q:return[]
 d=[_w(x.get("_doc")or _d(x))for x in I];n=len(d)or 1;a=sum(map(len,d))/n or 1;f={}
 for D in d:
  for t in set(D):f[t]=f.get(t,0)+1
 o=[]
 for x,D in zip(I,d):
  t={}
  for w in D:t[w]=t.get(w,0)+1
  s=0.0
  for w in q:
   c=t.get(w,0)
   if c:
    idf=math.log(1+(n-f.get(w,0)+.5)/(f.get(w,0)+.5));s+=idf*c*2.2/(c+1.2*(.25+.75*len(D)/a))
  if s>0:o.append((x,s))
 return sorted(o,key=lambda x:x[1],reverse=True)[:k]
_S={"id":"search_capabilities","name":"search_capabilities","description":"Find hidden tools/skills. Search before invoking.","inputSchema":{"type":"object","properties":{"query":{"type":"string"},"topK":{"type":"integer"}},"required":["query"]}}
_I={"id":"invoke_tool","name":"invoke_tool","description":"Run a hidden tool returned by search_capabilities.","inputSchema":{"type":"object","properties":{"toolId":{"type":"string"},"args":{"type":"object"}},"required":["toolId","args"]}}
_K={"id":"get_skill_content","name":"get_skill_content","description":"Load a skill playbook returned by search_capabilities.","inputSchema":{"type":"object","properties":{"skillId":{"type":"string"}},"required":["skillId"]}}
class Ratwo:
 def __init__(self,direct_tools=("memory_*",),top_k=5,embed=None,hybrid=.7,on_event=None):
  self.tools={};self.skills={};self.facts={};self.direct=tuple(direct_tools);self.top_k=top_k;self.embed=embed;self.hybrid=hybrid;self.on_event=on_event
 def is_direct(self,id):return any(_g(id,p)for p in self.direct)
 def _emit(self,type,**data):
  if self.on_event:
   try:self.on_event({"type":type,"at":int(time.time()*1000),**data})
   except Exception:pass
 async def register(self,*xs):
  flat=[]
  for x in xs:flat.extend(x if isinstance(x,(list,tuple))else[x])
  for x0 in flat:
   x0=vars(x0)if not isinstance(x0,dict)else x0
   id=x0.get("id")or x0.get("name");e=x0.get("execute")or x0.get("run")or x0.get("handler")
   if not id or not callable(e):raise ValueError("tool needs id/name + execute")
   if id in(_S["id"],_I["id"],_K["id"]):raise ValueError(f"reserved tool id: {id}")
   x={**x0,"id":id,"name":x0.get("name")or id,"description":_c(x0.get("description")),"inputSchema":x0.get("inputSchema")or x0.get("input_schema")or x0.get("parameters")or{"type":"object"},"outputSchema":x0.get("outputSchema")or x0.get("output_schema")or{},"execute":e}
   x["_doc"]=_d(x)
   if self.embed:x["_vec"]=await _m(self.embed(x["_doc"]))
   self.tools[id]=x;self._emit("tool.register",id=id,direct=self.is_direct(id))
  return self
 def register_skill(self,*xs):
  for x in xs:
   if not x.get("id"):raise ValueError("skill needs id")
   y={**x,"name":x.get("name")or x["id"],"description":_c(x.get("description")),"tools":x.get("tools",[]),"body":x.get("body")or x.get("content")or""};y["_doc"]=_d(y);self.skills[y["id"]]=y
  return self
 def register_fact(self,*xs):
  for x in xs:
   id=x.get("id")or f"fact_{len(self.facts)+1}";y={**x,"id":id,"name":x.get("name")or id,"description":_c(x.get("description")or x.get("content")),"content":x.get("content")or x.get("value")or""};y["_doc"]=_d(y)+" "+str(y["content"]);self.facts[id]=y
  return self
 async def _rank(self,I,q,k):
  base=_b(I,q,max(k*3,k))
  if not self.embed:return base[:k]
  qv=await _m(self.embed(q));mx=max([s for _,s in base]or[1e-9]);lx={x["id"]:s/mx for x,s in base};o=[]
  for x in I:
   if"_vec"not in x:x["_vec"]=await _m(self.embed(x.get("_doc")or _d(x)))
   s=self.hybrid*lx.get(x["id"],0)+(1-self.hybrid)*_cs(qv,x.get("_vec"))
   if s>0:o.append((x,s))
  return sorted(o,key=lambda z:z[1],reverse=True)[:k]
 async def search_capabilities(self,q,top_k=None):
  k=max(1,min(20,int(top_k or self.top_k)));t=[x for x in self.tools.values()if not self.is_direct(x["id"])];s=list(self.skills.values());th,sh=await asyncio.gather(self._rank(t,q,k),self._rank(s,q,k))
  out={"tools":[{"id":x["id"],"description":_c(x.get("description")),"inputSchema":x["inputSchema"],"score":round(s,4)}for x,s in th],"skills":[{"id":x["id"],"description":_c(x.get("description")),"tools":x.get("tools",[]),"score":round(s,4)}for x,s in sh]};self._emit("search",query=_c(q,200),toolHits=len(out["tools"]),skillHits=len(out["skills"]));return out
 async def _run(self,x,a,ctx=None,origin="direct"):
  _ch(a,x.get("inputSchema"));t=time.time()
  try:
   try:r=x["execute"](a,ctx)
   except TypeError:r=x["execute"](a)
   r=await _m(r);self._emit("invoke",id=x["id"],origin=origin,ms=int((time.time()-t)*1000),ok=True);return r
  except Exception as e:self._emit("invoke",id=x["id"],origin=origin,ms=int((time.time()-t)*1000),ok=False,error=str(e));raise
 async def invoke_tool(self,tool_id,a=None,ctx=None):
  x=self.tools.get(tool_id)
  if not x:raise KeyError(f"unknown tool: {tool_id}")
  if self.is_direct(tool_id):raise ValueError(f"{tool_id} is direct; call it by its literal name")
  return await self._run(x,a or{},ctx,"invoke")
 def get_skill_content(self,skill_id):
  x=self.skills.get(skill_id)
  if not x:raise KeyError(f"unknown skill: {skill_id}")
  return{"skillId":skill_id,"body":x["body"],"tools":x["tools"]}
 def ground(self,text,top_k=3):h=_b(list(self.facts.values()),text,top_k);return chr(10).join(x["content"]for x,_ in h if x.get("content")and str(x["content"])not in str(text))
 async def recall(self,q,top_k=None):return(await self.search_capabilities(q,top_k))["tools"]
 def model_tools(self):
  async def search(a,c=None):return await self.search_capabilities(a["query"],a.get("topK"))
  async def invoke(a,c=None):return await self.invoke_tool(a["toolId"],a.get("args",{}),c)
  async def skill(a,c=None):return self.get_skill_content(a["skillId"])
  out={_S["id"]:{**_S,"execute":search},_I["id"]:{**_I,"execute":invoke},_K["id"]:{**_K,"execute":skill}}
  for x in self.tools.values():
   if self.is_direct(x["id"]):
    async def run(a,c=None,_x=x):return await self._run(_x,a,c,"direct")
    out[x["id"]]={"name":x["name"],"description":x["description"],"inputSchema":x["inputSchema"],"execute":run}
  return out
 def openai_tools(self):return[{"type":"function","function":{"name":x["name"],"description":x["description"],"parameters":x["inputSchema"]}}for x in self.model_tools().values()]
 async def handle_tool_call(self,name,a=None,ctx=None):
  x=self.model_tools().get(name)
  if not x:raise KeyError(f"model cannot call: {name}")
  if isinstance(a,str):a=json.loads(a)
  return await x["execute"](a or{},ctx)
 async def use_memory(self,memory,recall=True,forget=True):
  mr=getattr(memory,"memory_remember",None);remember=mr or getattr(memory,"remember",None)
  if not callable(remember):raise ValueError("memory plugin needs remember()/memory_remember()")
  async def rem(a):return await _m(remember(a)if mr else remember(a["content"],a.get("tags",[])))
  tools=[{"id":"memory_remember","description":"Store durable memory.","inputSchema":{"type":"object","properties":{"content":{"type":"string"},"tags":{"type":"array","items":{"type":"string"}}},"required":["content"]},"execute":rem}]
  rc=getattr(memory,"memory_recall",None)or getattr(memory,"recall",None)
  if recall and callable(rc):
   async def rec(a):return await _m(rc(a)if hasattr(memory,"memory_recall")else rc(a["query"],a.get("limit",5)))
   tools.append({"id":"memory_recall","description":"Recall relevant durable memories.","inputSchema":{"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"integer"}},"required":["query"]},"execute":rec})
  fg=getattr(memory,"memory_forget",None)or getattr(memory,"forget",None)
  if forget and callable(fg):
   async def dele(a):return await _m(fg(a)if hasattr(memory,"memory_forget")else fg(a["id"]))
   tools.append({"id":"memory_forget","description":"Delete a durable memory by id.","inputSchema":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]},"execute":dele})
  return await self.register(tools)
class MemoryStore:
 def __init__(self,file=None):self.file=Path(file)if file else None;self.items=[]
 async def load(self):
  if self.file and self.file.exists():self.items=json.loads(self.file.read_text())
  return self
 async def _save(self):
  if self.file:
   tmp=self.file.with_suffix(self.file.suffix+".tmp");tmp.write_text(json.dumps(self.items,separators=(",",":")));os.replace(tmp,self.file)
 async def remember(self,content,tags=None):
  content=str(content or"").strip();tags=tags or[]
  if not content:raise ValueError("content required")
  x=next((x for x in self.items if x["content"]==content),None)
  if x:x["tags"]=list(dict.fromkeys(x.get("tags",[])+tags));x["updatedAt"]=int(time.time()*1000)
  else:x={"id":"m_"+uuid.uuid4().hex[:12],"content":content,"tags":tags,"createdAt":int(time.time()*1000)};self.items.append(x)
  await self._save();return{"id":x["id"],"stored":True}
 async def recall(self,q,limit=5):
  xs=[{**x,"_doc":x["content"]+" "+" ".join(x.get("tags",[]))}for x in self.items];return[{**x,"score":round(s,4)}for x,s in _b(xs,q,max(1,min(20,int(limit or 5))))]
 async def forget(self,id):
  n=len(self.items);self.items=[x for x in self.items if x["id"]!=id]
  if len(self.items)!=n:await self._save()
  return{"deleted":n-len(self.items)}
def ratwo(**kwargs):return Ratwo(**kwargs)
async def _self_test():
 r=ratwo();seen={}
 await r.register({"id":"sum","description":"Add two numbers","inputSchema":{"type":"object","properties":{"a":{"type":"number"},"b":{"type":"number"}},"required":["a","b"]},"execute":lambda a:a["a"]+a["b"]},{"id":"memory_remember","description":"remember","inputSchema":{"type":"object","properties":{"content":{"type":"string"}},"required":["content"]},"execute":lambda a:seen.update(value=a["content"])or{"ok":True}})
 assert"memory_remember"in r.model_tools()and"sum"not in r.model_tools();assert any(x["id"]=="sum"for x in(await r.search_capabilities("add numbers"))["tools"]);await r.handle_tool_call("memory_remember",{"content":"x"});assert seen["value"]=="x"
 try:await r.invoke_tool("memory_remember",{"content":"bad"});raise AssertionError("direct proxy not blocked")
 except ValueError as e:assert"direct"in str(e)
 print("ratwo.py self-test: ok")
if __name__=="__main__"and"--self-test"in sys.argv:asyncio.run(_self_test())
