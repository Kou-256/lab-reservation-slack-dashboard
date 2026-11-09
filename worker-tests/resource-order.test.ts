import {it,expect} from 'vitest';
import {parseResourceOrder,orderedResources} from '../shared/resource-order';
it('ignores malformed settings and duplicate/invalid IDs',()=>{
 expect(parseResourceOrder('broken')).toEqual([]);expect(parseResourceOrder('{"id":"a"}')).toEqual([]);
 expect(parseResourceOrder('["b",null,"a","b",2,""]')).toEqual(['b','a']);
});
it('preserves new equipment registration order and never mutates the source',()=>{
 const resources=[{id:'a'},{id:'b'},{id:'c'},{id:'d'}];
 expect(orderedResources(resources,['deleted','b','a']).map(r=>r.id)).toEqual(['b','a','c','d']);
 expect(resources.map(r=>r.id)).toEqual(['a','b','c','d']);
});
