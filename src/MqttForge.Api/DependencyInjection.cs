using MqttForge.Api.Realtime;
using MqttForge.Application.Alerts;
using MqttForge.Application.Services;
using MqttForge.Domain.Abstractions;
using MqttForge.Infrastructure.Alerts;
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
        // The shipped record with the two operator-facing values laid over it, read at resolve
        // time rather than at registration so a late-configuring host — every test in this suite —
        // still gets the configuration it set. This replaces the plain 'new AlertEngineOptions()'
        // plan 2 registered to get the engine standing; the engine holds this same object either
        // way, and only the two values below can now differ from the shipped ones.
        services.AddSingleton(sp => AlertOptions(sp.GetRequiredService<IConfiguration>()));

        // The rule service the endpoints ask for. It is registered here rather than beside the
        // other services above because it is the only one of them that holds the engine: a save
        // goes to the store and then straight into the engine's queue, so the two can never drift
        // into disagreeing about what the rule set is.
        services.AddSingleton<AlertRuleService>();
        services.AddSingleton<AlertEngineCore>();

        // The two panel numbers no snapshot can carry: how long the engine has been blind, which
        // BrokerLinkSupervisor stamps on every poll, and how many webhook deliveries were dropped,
        // which the webhook dispatcher counts. Registered before either of its writers, so that
        // both of them are handed the same object the endpoint reads.
        services.AddSingleton<AlertPanelCounters>();

        // Two channels for one engine. The hub is what a console hears; the log is what a
        // container leaves behind, and dropping it when SignalR arrived would have made a
        // headless MQTTForge — the deployment this feature was written for — run rules and tell
        // nobody. Both are registered under their own types as well, because the composite is not
        // their only caller: the mute endpoint resolves SignalRAlertNotifier by name.
        services.AddSingleton<LoggingAlertNotifier>();
        services.AddSingleton<SignalRAlertNotifier>();
        services.AddSingleton<IAlertNotifier>(sp => new CompositeAlertNotifier(
            sp.GetRequiredService<LoggingAlertNotifier>(),
            sp.GetRequiredService<SignalRAlertNotifier>(),
            sp.GetRequiredService<ILogger<CompositeAlertNotifier>>()));

        // The named client, built from the dispatcher's own handler: AllowAutoRedirect false, so
        // a 3xx is an answer the dispatcher calls a failure rather than a hop to an address the
        // user never wrote down, and PooledConnectionLifetime, because this singleton holds one
        // client for the life of the process. No per-client Timeout: the dispatcher's attempt
        // deadline runs on its injected clock, and HttpClient's own would be a second deadline on
        // a clock no test can reach.
        services.AddHttpClient(WebhookDispatcher.ClientName)
            .ConfigurePrimaryHttpMessageHandler(WebhookDispatcher.CreateHandler);

        // Asked for by name, and NOT registered by type. AddHttpClient also registers a bare
        // transient HttpClient bound to the unnamed client — so AddSingleton<WebhookDispatcher>()
        // resolves happily and hands it the default handler, which follows redirects. That is the
        // one mistake this whole registration exists to prevent, and it fails silently.
        services.AddSingleton(sp => new WebhookDispatcher(
            sp.GetRequiredService<IHttpClientFactory>().CreateClient(WebhookDispatcher.ClientName),
            sp.GetRequiredService<AlertEngineOptions>(),
            sp.GetRequiredService<ILogger<WebhookDispatcher>>(),
            panel: sp.GetRequiredService<AlertPanelCounters>()));

        services.AddSingleton<MqttAlertDispatcher>();

        // Ahead of AlertEngineHost, and that is the whole reason it is registered here rather
        // than beside the other two hosted services at the bottom: hosted services start in
        // registration order, and a queue the engine starts filling before anything drains it
        // loses the first alarms of a run.
        services.AddHostedService(sp => sp.GetRequiredService<WebhookDispatcher>());

        // The engine takes one dispatcher and there are two channels, so this is where they are
        // put together — and where MqttForge:AllowWebhooks is honoured. With the switch off the
        // webhook channel is not in the list at all: the pump above still runs and is simply
        // never given anything. That is deliberately the blunt gate, because a switch enforced
        // only inside a class is one forgotten branch away from doing nothing.
        //
        // The broker channel is never gated. Turning webhooks off is about what leaves for an
        // address the operator typed, not about alerting going quiet.
        services.AddSingleton<IAlertDispatcher>(sp => new CompositeAlertDispatcher(
            sp.GetRequiredService<AlertEngineOptions>().AllowWebhooks
                ? [sp.GetRequiredService<WebhookDispatcher>(), sp.GetRequiredService<MqttAlertDispatcher>()]
                : [sp.GetRequiredService<MqttAlertDispatcher>()],
            sp.GetRequiredService<ILogger<CompositeAlertDispatcher>>()));

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
        //
        // The dispatcher is passed by name. It and the clock are both optional parameters, and a
        // positional argument here would tie this file to whichever order they ended up in.
        services.AddSingleton(sp => new AlertEngine(
            sp.GetRequiredService<AlertEngineCore>(),
            sp.GetRequiredService<IAlertRuleStore>(),
            sp.GetRequiredService<IAlertStateStore>(),
            sp.GetRequiredService<IAlertNotifier>(),
            sp.GetRequiredService<IMqttConnectionManager>(),
            new DeferredSubscriber(sp),
            sp.GetRequiredService<ILogger<AlertEngine>>(),
            dispatcher: sp.GetRequiredService<IAlertDispatcher>()));

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
        // Two hosted services rather than one, because they answer to different things. The pump
        // has to run whether or not a broker is reachable — the panel still has to be able to say
        // why nothing is firing — and the link has to be supervised whether or not the pump is
        // busy. Folding them together would make each one's failure the other's.
        //
        // Order matters, and only between these two: hosted services start in the order they were
        // registered, so the engine's loop is already pumping before the supervisor dials a
        // broker. Registered the other way round, the first seconds of traffic after a reconnect
        // would land in a queue with nothing draining it.
        services.AddHostedService<AlertEngineHost>();
        services.AddHostedService<BrokerLinkSupervisor>();
        return services;
    }


        /// <summary>
        /// The two things an operator can turn, laid over the shipped defaults.
        /// </summary>
        // A record 'with' rather than configuration binding: the other twelve members are ceilings
        // this app does not offer as settings, and binding the section would quietly make every one
        // of them settable — including MaxReadings, which is a memory budget, and MinWindow, which a
        // condition's arithmetic depends on.
        private static AlertEngineOptions AlertOptions(IConfiguration config)
        {
            var shipped = new AlertEngineOptions();

            return shipped with
            {
                TopicPrefix = Prefix(config["MqttForge:AlertTopicPrefix"], shipped.TopicPrefix),

                // Only 'true' and 'false' are answers. Anything else is a value nobody can read, and
                // the shipped default stands: of the two ways to be wrong here, the one that turns an
                // alerting channel off without saying so is the worse one.
                AllowWebhooks = !bool.TryParse(config["MqttForge:AllowWebhooks"], out var allow) || allow
            };
        }

        /// <summary>A prefix that is really a prefix: non-empty, and ending where a topic level does.</summary>
        // Without the slash, 'site/alarms' in front of 'hot/plant/boiler/temp' is 'site/alarmshot/…' —
        // a topic tree nobody meant to create, and one the engine's own loop guard cannot recognise
        // as its own. Empty is the worse case and is refused outright: an empty prefix would make
        // every topic on the broker look like the engine's own publication.
        private static string Prefix(string? configured, string shipped)
        {
            var prefix = configured?.Trim();
            if (string.IsNullOrEmpty(prefix)) return shipped;

            return prefix.EndsWith('/') ? prefix : prefix + '/';
        }
}
