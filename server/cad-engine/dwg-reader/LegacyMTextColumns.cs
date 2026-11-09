using ACadSharp.Entities;
using ACadSharp.XData;
using Row = System.Collections.Generic.Dictionary<string, object?>;

// Pre-R2018 column definitions live in ACAD XData, not ACadSharp.ColumnData.
// Retain the typed source sections even when decoding or layout is unavailable.
static class LegacyMTextColumns
{
    public static Row? Read(MText text)
    {
        var records = text.ExtendedData.Where(p => p.Key.Name == "ACAD").SelectMany(p => p.Value.Records).ToArray();
        string[] names = ["ACAD_MTEXT_COLUMN_INFO", "ACAD_MTEXT_COLUMNS", "ACAD_MTEXT_DEFINED_HEIGHT"];
        var sections = new Dictionary<string, ExtendedDataRecord[]>();
        var raw = new List<object>();
        bool complete = true;
        foreach (string name in names) {
            var starts = records.Select((r,i) => (r,i)).Where(p => p.r.RawValue is string s && s == name+"_BEGIN").Select(p => p.i).ToArray();
            var ends = records.Select((r,i) => (r,i)).Where(p => p.r.RawValue is string s && s == name+"_END").Select(p => p.i).ToArray();
            if(starts.Length == 0 && ends.Length == 0) continue;
            bool valid = starts.Length == 1 && ends.Length == 1 && ends[0] > starts[0];
            complete &= valid;
            int first = starts.FirstOrDefault(-1), last = ends.FirstOrDefault(records.Length);
            var tags = first >= 0 && last > first ? records[(first+1)..last] : Array.Empty<ExtendedDataRecord>();
            raw.Add(new {name, complete=valid});
            if(valid) sections[name] = tags;
        }
        if(raw.Count == 0) return null;
        var result = new Row { ["encoding"]="legacy-acad-xdata", ["sections"]=raw,
            ["sourceRecords"]=records.Select(r => new {code=(int)r.Code, value=r is ExtendedDataHandle h ? (object)h.Value.ToString("X") : r.RawValue}).ToArray(),
            ["nativeHasColumns"]=text.HasColumns, ["parseStatus"]="incomplete", ["preview"]="unavailable" };
        if(!complete) return result;
        var values = new Dictionary<int, object>();
        var heights = new List<double>();
        bool Decode(ExtendedDataRecord[] tags, params int[] allowed) {
            for(int i=0;i<tags.Length;) {
                if(tags[i++] is not ExtendedDataInteger16 key || i>=tags.Length || !allowed.Contains(key.Value) || values.ContainsKey(key.Value)) return false;
                var value = tags[i++];
                bool integer = key.Value is 75 or 76 or 78 or 79 or 50 or 47;
                if(integer ? value is not ExtendedDataInteger16 : value is not ExtendedDataReal) return false;
                values[key.Value] = value.RawValue;
                if(key.Value == 50) {
                    int count = (short)value.RawValue;
                    if(count<0 || count>tags.Length-i) return false;
                    for(int h=0;h<count;h++) {
                        if(tags[i++] is not ExtendedDataReal height) return false;
                        heights.Add(height.Value);
                    }
                }
            }
            return true;
        }
        if(sections.TryGetValue(names[0],out var info) && !Decode(info,75,76,78,79,48,49,50)) return result;
        if(sections.TryGetValue(names[2],out var defined) && !Decode(defined,46)) return result;
        var handles = new List<string>();
        if(sections.TryGetValue(names[1],out var links)) {
            if(links.Length<2 || !Decode(links[..2],47)) return result;
            foreach(var tag in links[2..]) {
                if(tag is not ExtendedDataHandle handle) return result;
                handles.Add(handle.Value.ToString("X"));
            }
        }
        string[] fields = ["columnType","columnCount","flowReversed","autoHeight","columnWidth","gutterWidth","heightCount","linkedColumnCount","definedHeight"];
        int[] codes = [75,76,78,79,48,49,50,47,46];
        for(int i=0;i<codes.Length;i++) if(values.TryGetValue(codes[i],out var value)) result[fields[i]]=value;
        result["heights"] = heights;
        result["linkedHandles"] = handles;
        result["parseStatus"] = "parsed";
        if(!sections.ContainsKey(names[0]) && !sections.ContainsKey(names[1])) {
            result["preview"]="ordinary-text"; return result;
        }
        if(values.TryGetValue(75,out var type) && (short)type==0 && handles.Count==0
            && !sections.ContainsKey(names[1])) { result["preview"]="ordinary-text"; return result; }
        // Only preview an explicitly single, independently stored column. Its height
        // and flow are not implemented: this remains an approximation, even at count 1.
        bool hasFields = new[]{75,76,78,79,48,49}.All(values.ContainsKey);
        if(hasFields && (short)values[75] is 1 or 2 && (short)values[76]==1
            && (short)values[78] is 0 or 1 && (short)values[79] is 0 or 1
            && (double)values[48]>0 && double.IsFinite((double)values[48])
            && (double)values[49]>=0 && double.IsFinite((double)values[49])
            && handles.Count==0 && (!values.ContainsKey(47) || (short)values[47]==1)
            && !text.HasColumns) result["preview"]="single-column-approximation";
        return result;
    }
}
