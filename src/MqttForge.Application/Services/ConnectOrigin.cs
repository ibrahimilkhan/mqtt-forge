namespace MqttForge.Application.Services;

/// <summary>Who is asking for a connection: a person, or the supervisor redialling for them.</summary>
public enum ConnectOrigin
{
    /// <summary>A person pressed Connect. This dial supersedes whatever link was standing.</summary>
    Reader,

    /// <summary>The supervisor, putting back a link that dropped or one the rules want.</summary>
    Supervisor,
}
