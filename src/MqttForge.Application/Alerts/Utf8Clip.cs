using System.Text;

namespace MqttForge.Application.Alerts;

/// <summary>
/// A text cut to a byte budget, never in the middle of a character. The one place an alert's
/// sample is shortened: the hub's row and the outgoing body each have their own budget, and only
/// the budget differs between them.
/// </summary>
public static class Utf8Clip
{
    /// <summary><paramref name="text"/>, or as much of it as fits in <paramref name="budget"/> bytes.</summary>
    // Bytes, because that is what a budget is about — a frame, a body — and whole characters,
    // because that is what the reader sees. A cut counted in bytes lands inside a character about a
    // fifth of the time on a payload with any non-ASCII in it, and half a character is a U+FFFD on
    // a panel, in somebody's database, or a body their parser rejects outright.
    public static string? To(string? text, int budget)
    {
        if (text is null) return null;

        // The ordinary path pays one comparison and allocates nothing. No char encodes to more than
        // three UTF-8 bytes — the four-byte characters are surrogate pairs, which are two chars — so
        // a string this short cannot possibly exceed the budget.
        if (text.Length <= budget / 3) return text;

        var bytes = Encoding.UTF8.GetBytes(text);
        if (bytes.Length <= budget) return text;

        // 10xxxxxx is a continuation byte; walking back off them lands on the first byte of the
        // character the cut fell inside, and dropping that character whole is the answer.
        var end = budget;
        while (end > 0 && (bytes[end] & 0xC0) == 0x80) end--;

        return Encoding.UTF8.GetString(bytes, 0, end);
    }
}
