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
        return Normalize(decoded==value?mtext.PlainText:new MText{Value=decoded}.PlainText);
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
