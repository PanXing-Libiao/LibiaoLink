// Selected ACadSharp.Image SvgTextLayout algorithm, ported to Canvas metrics.
// MIT, Copyright (c) 2026 ACadSharp.Image Contributors. LICENSE.acadsharp-image.
// Source: ACadSharp.Image/Rendering/Svg/SvgTextLayout.cs (content pin in
// drawing-index-dependencies.json). No ImageSharp/SixLabors runtime is included.
// This preserves the upstream greedy breaks, whitespace and overlong-token rule;
// substituted browser fonts remain an explicit display loss.
export function cadTextTokens(paragraph){
 const tokens=[];let start=0,index=0;
 const breaking=value=>value===' '||value==='\t';
 while(index<paragraph.length){
  const current=paragraph[index];
  if(breaking(current)){while(index<paragraph.length&&breaking(paragraph[index]))index++;}
  else if((current==='-'||current==='/')&&index+1<paragraph.length&&!breaking(paragraph[index+1]))index++;
  else {index++;continue;}
  tokens.push(paragraph.slice(start,index));start=index;
 }
 if(start<paragraph.length)tokens.push(paragraph.slice(start));return tokens;
}
export function wrapCadText(text,wrappingWidth,emSize,measureReference){
 const paragraphs=String(text).replace(/\r\n/g,'\n').split('\n');
 if(!(wrappingWidth>0)||!(emSize>0))return paragraphs;
 const limit=wrappingWidth*100/emSize,lines=[];
 for(const paragraph of paragraphs){
  let current='';
  for(const token of cadTextTokens(paragraph)){
   if(!current.length){current=token;continue;}
   const candidate=current+token;
   if(measureReference(candidate.replace(/[ \t]+$/,''))<=limit)current=candidate;
   else{lines.push(current.replace(/[ \t]+$/,''));current=token;}
  }
  lines.push(current);
 }
 return lines;
}
export const cadTextEm=capHeight=>capHeight*4/3;
export const cadLineHeight=(capHeight,lineSpacing=1)=>capHeight*(lineSpacing>0?lineSpacing:1)*5/3;
