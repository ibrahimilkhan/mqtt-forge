namespace MqttForge.Api.Contracts;

/// <summary>Where saved readings are going, and whether this host can be asked to change it.</summary>
public sealed record ExportFolderDto(string? Folder, bool CanChoose);

/// <summary>A file to write into the chosen folder. The folder is never taken from the caller.</summary>
public sealed record SaveCsvDto(string Name, string Content);

/// <summary>Where the file landed, so the interface can say so rather than claim it.</summary>
public sealed record SavedDto(string Path);
