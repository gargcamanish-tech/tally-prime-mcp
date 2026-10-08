const t = await import('../src/tally.js');
const [type, name, ...methods] = process.argv.slice(2);
const xml = '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>C1</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="C1" ISMODIFY="No"><TYPE>' + type + '</TYPE>' + methods.map(m => '<NATIVEMETHOD>' + m + '</NATIVEMETHOD>').join('') + '<FILTER>F1</FILTER></COLLECTION><SYSTEM TYPE="Formulae" NAME="F1">$Name = "' + name + '"</SYSTEM></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>';
const r = await t.postXml(xml);
const body = r.slice(r.indexOf('<' + type.toUpperCase() + ' '));
// drop empty lists, empty tags, "No"/0/"Not Applicable" noise
const cleaned = body
  .replace(/<([A-Z.]+)( [^>]*)?\/>/g, '')
  .replace(/<([A-Z.]+)( TYPE="[^"]*")?>(No|0|&#4; Not Applicable)<\/\1>/g, '')
  .split(/\r?\n/).filter((l) => l.trim()).join('\n');
let prev; let s = cleaned;
do { prev = s; s = s.replace(/\s*<([A-Z.]+\.LIST)( [^>]*)?>\s*<\/\1>/g, ''); } while (s !== prev);
console.log(s.slice(0, Number(process.env.MAX || 6000)));
