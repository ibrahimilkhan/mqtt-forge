using MqttForge.Api.Realtime;
using MqttForge.Application.Alerts;
using MqttForge.Application.Services;
using MqttForge.Domain.Abstractions;
using MqttForge.Infrastructure.Mqtt;
using MqttForge.Infrastructure.Persistence;

namespace MqttForge.Api;

public static class DependencyInjection
{
    public static IServiceCollection AddMqttForge(this IServiceCollection services)
    {
        // Single MQTTnet client for all requests (one active connection)
        services.AddSingleton<MqttnetClientProvider>();
        services.AddSingleton<IMqttConnectionManager, MqttnetConnectionManager>();
        services.AddSingleton<IMqttPublisher, MqttnetPublisher>();
        // One instance wearing both hats: the notifier that queues, and the pump that drains it.
        // It is no longer registered as IMessageNotifier — the fan-out below is, and this is one
        // of the two places that fan-out forwards to.
        services.AddSingleton<SignalRMessageNotifier>();
        services.AddHostedService(sp => sp.GetRequiredService<SignalRMessageNotifier>());
        services.AddSingleton<IConnectionStateNotifier, SignalRConnectionStateNotifier>();
        services.AddSingleton<IMqttSubscriber, MqttnetSubscriber>();

        // Read at resolve time, not registration, so late-configuring hosts (tests) still work
        services.AddSingleton<IConnectionSettingsStore>(sp =>
            new JsonConnectionSettingsStore(StorePaths.ConnectionSettings(sp.GetRequiredService<IConfiguration>())));

        services.AddSingleton<IColourRuleStore>(sp =>
            new JsonColourRuleStore(StorePaths.ColourRules(sp.GetRequiredService<IConfiguration>())));

        services.AddSingleton<ISavedProfileStore>(sp =>
            new JsonSavedProfileStore(StorePaths.SavedProfiles(sp.GetRequiredService<IConfiguration>())));

        services.AddSingleton<IAlertRuleStore>(sp =>
            new JsonAlertRuleStore(StorePaths.AlertRules(sp.GetRequiredService<IConfiguration>())));

        // Two arguments, unlike the four stores above it: this one says so in the log when it
        // cannot write, because nobody is waiting on the answer. The engine's shutdown save has
        // no request behind it to fail, so a silent store would lose the handover without a word.
        services.AddSingleton<IAlertStateStore>(sp =>
            new JsonAlertStateStore(
                StorePaths.AlertState(sp.GetRequiredService<IConfiguration>()),
                sp.GetRequiredService<ILogger<JsonAlertStateStore>>()));

        // The engine is one owner and one transport around it. The core holds every piece of
        // alerting state and has no lock, which is safe only because AlertEngine's pump is the
        // single thread that ever calls into it — so both are singletons and neither is resolved
        // anywhere a request thread could touch it.
        services.AddSingleton(new AlertEngineOptions());
        services.AddSingleton<AlertEngineCore>();
        services.AddSingleton<IAlertNotifier, LoggingAlertNotifier>();

        // Written out by hand for one argument: the subscriber. See DeferredSubscriber for the
        // ring this opens — MqttnetSubscriber is built with an IMessageNotifier, that notifier is
        // now the fan-out, the fan-out is built with this engine, and this engine needs a
        // subscriber. The container cannot see that ring (it runs through a factory registration)
        // so it walks it until the stack ends, and MqttForgeHost.Build resolves IMqttSubscriber
        // on its last line. Everything else here is exactly what the container would have passed.
        //
        // The clock is left to its own default — TimeProvider.System — rather than registered, so
        // that a test wanting a fake one hands it to the engine directly instead of silently
        // swapping the clock under MqttnetConnectionManager as well.
        services.AddSingleton(sp => new AlertEngine(
            sp.GetRequiredService<AlertEngineCore>(),
            sp.GetRequiredService<IAlertRuleStore>(),
            sp.GetRequiredService<IAlertStateStore>(),
            sp.GetRequiredService<IAlertNotifier>(),
            sp.GetRequiredService<IMqttConnectionManager>(),
            new DeferredSubscriber(sp),
            sp.GetRequiredService<ILogger<AlertEngine>>()));

        // The message path forks here rather than inside MqttnetSubscriber, which goes on knowing
        // that it hands a message over and nothing about who to. Recording joins the same list.
        //
        // One instance under two faces, the way SignalRMessageNotifier already is: the subscriber
        // gets it as IMessageNotifier, and a test can ask for it by name and know it is holding
        // the same object. Two fan-outs would both work and only one of them would be the one the
        // broker is actually feeding.
        //
        // The constructor is named rather than left to the activator, because this class has two
        // public ones and which of them the container would choose is a question nobody should
        // have to answer twice.
        services.AddSingleton(sp => new FanOutMessageNotifier(
            sp.GetRequiredService<SignalRMessageNotifier>(),
            sp.GetRequiredService<AlertEngine>()));
        services.AddSingleton<IMessageNotifier>(sp => sp.GetRequiredService<FanOutMessageNotifier>());

        services.AddSingleton<ConnectionService>();
        services.AddSingleton<ColourRuleService>();
        services.AddSingleton<SavedProfileService>();
        services.AddSingleton<PublishService>();
        services.AddSingleton<SubscriptionService>();
        // One window, so one dialog on it — whichever of the two asked for it.
        services.AddSingleton<HostDialogs>();
        // Both pickers are registered by the host that owns that window, and by nothing else — a
        // run with no window resolves null here and each interface says so its own way: the
        // export falls back to a download, and the certificate boxes stay boxes you type into.
        services.AddSingleton(sp => new ExportService(
            sp.GetService<IFolderPicker>(), sp.GetRequiredService<HostDialogs>()));
        services.AddSingleton(sp => new CertificatePicker(
            sp.GetService<IFilePicker>(), sp.GetRequiredService<HostDialogs>()));
        return services;
    }
}
