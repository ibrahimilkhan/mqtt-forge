using MqttForge.Application.Services;

namespace MqttForge.Api.Contracts;

/// <summary>
/// Whether this host can be asked for a certificate file at all.
/// </summary>
/// <remarks>
/// False in a browser and true in the desktop window, and the difference is not a setting — the
/// dialog belongs to the host, and only a host that owns a window has one. The same fact the
/// export folder reports, asked here because the broker panel has its own three boxes to fill.
/// </remarks>
public sealed record CertificateDialogDto(bool CanChoose);

/// <summary>
/// Which of the three boxes is being filled in, which is what names the dialog.
/// </summary>
/// <remarks>
/// Nullable so that a body which names no field is a body with no field in it. Left as the bare
/// enum, an empty <c>{}</c> bound to whichever kind happens to be first and opened that dialog —
/// an answer nobody asked for, on somebody's screen.
/// </remarks>
public sealed record PickCertificateFileDto(CertificatePicker.Kind? Kind);

/// <summary>The file chosen, or null when the dialog was dismissed.</summary>
public sealed record CertificateFileDto(string? Path);
