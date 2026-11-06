using System.Text;
using System.Text.RegularExpressions;
using ACadSharp.Entities;

// Selected text-normalization methods from ACadSharp.Image TextRenderer.
// MIT, Copyright (c) 2026 ACadSharp.Image Contributors. See LICENSE.community.
// https://github.com/slaveOftime/ACadSharp.Image/blob/main/ACadSharp.Image/Rendering/TextRenderer.cs
// Decoding stays in ACadSharp; this expands CAD text escapes before its plain-text
// projection can drop their backslash. Formatting/glyph layout remains a loss.
static class CommunityText
{
    static readonly Regex UnicodeEscape = new(@"\\[Uu]\+([0-9A-Fa-f]{4})",RegexOptions.Compiled);
    public static string Plain(MText mtext)
    {
        string value=mtext.Value??string.Empty;
        string decoded=UnicodeEscape.Replace(value,m=>((char)Convert.ToInt32(m.Groups[1].Value,16)).ToString());
        decoded=StripWidthControls(decoded);
        return Normalize(decoded==value?mtext.PlainText:new MText{Value=decoded}.PlainText);
    }
    // ACadSharp's plain-text projection handles font/color/height controls but
    // leaves the parameter of \W in the visible text. Keep rawText untouched;
    // discard only width formatting here, respecting escaped backslashes.
    static string StripWidthControls(string value)
    {
        var result=new StringBuilder(value.Length);
        for(int i=0;i<value.Length;i++)
        {
            if(value[i]=='\\' && i+1<value.Length)
            {
                if(value[i+1]=='W')
                {
                    int end=value.IndexOf(';',i+2);
                    if(end>=0 && double.TryParse(value.AsSpan(i+2,end-i-2),
                        System.Globalization.NumberStyles.Float,System.Globalization.CultureInfo.InvariantCulture,out _))
                    { i=end; continue; }
                }
                result.Append(value[i]); result.Append(value[++i]);
            }
            else result.Append(value[i]);
        }
        return result.ToString();
    }
    public static string Normalize(string? value)
    {
        if(string.IsNullOrEmpty(value))return string.Empty;
        string text=UnicodeEscape.Replace(value,m=>((char)Convert.ToInt32(m.Groups[1].Value,16)).ToString());
        return text.Replace("%%%","\u0001",StringComparison.Ordinal)
            .Replace("%%C","Ø",StringComparison.OrdinalIgnoreCase)
            .Replace("%%D","°",StringComparison.OrdinalIgnoreCase)
            .Replace("%%P","±",StringComparison.OrdinalIgnoreCase)
            .Replace("%%U",string.Empty,StringComparison.OrdinalIgnoreCase)
            .Replace("%%O",string.Empty,StringComparison.OrdinalIgnoreCase)
            .Replace("\u0001","%",StringComparison.Ordinal)
            .Replace("\\P","\n",StringComparison.OrdinalIgnoreCase)
            .Replace("\r\n","\n",StringComparison.Ordinal).Replace('\r','\n');
    }
}
