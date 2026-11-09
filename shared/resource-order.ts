// 端末内の手動順だけを読み、未知の設備は登録順で末尾に追加する。
export function parseResourceOrder(value:string|null):string[]{
 try{const items=JSON.parse(value??'[]');return Array.isArray(items)?[...new Set(items.filter((x):x is string=>typeof x==='string'&&x.length>0&&x.length<=100))].slice(0,1000):[];}catch{return [];}
}
export function orderedResources<T extends {id:string}>(resources:T[],order:string[]):T[]{
 const rank=new Map(order.map((id,index)=>[id,index]));
 return resources.map((resource,index)=>({resource,index})).sort((a,b)=>(rank.get(a.resource.id)??Infinity)-(rank.get(b.resource.id)??Infinity)||a.index-b.index).map(x=>x.resource);
}
