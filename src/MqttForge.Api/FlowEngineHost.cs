using MqttForge.Application.Flows;

namespace MqttForge.Api;

/// <summary>Runs the flow engine's pump for the life of the process.</summary>
// AlertEngineHost's shape, less the hand-over: flow alarms do not outlive the process in this
// version. Every path is caught, including start-up — this is an experimental feature, and an
// experiment that could stop the console from starting would be a bad trade.
public sealed class FlowEngineHost : BackgroundService
{
    private readonly FlowEngine _engine;
    private readonly ILogger<FlowEngineHost> _log;

    public FlowEngineHost(FlowEngine engine, ILogger<FlowEngineHost> log)
    {
        _engine = engine;
        _log = log;
    }

    public override async Task StartAsync(CancellationToken cancellationToken)
    {
        try
        {
            await _engine.StartAsync(cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.LogError(ex, "The flow engine could not start its flows. It will run what it is given from now on.");
        }

        await base.StartAsync(cancellationToken);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await _engine.RunAsync(stoppingToken);
        }
        catch (OperationCanceledException)
        {
            // Shutdown.
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "The flow engine stopped. No flows are running.");
        }
    }
}
