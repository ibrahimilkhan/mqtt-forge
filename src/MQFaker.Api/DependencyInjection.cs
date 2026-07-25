using MQFaker.Application.Services;
using MQFaker.Domain.Abstractions;
using MQFaker.Infrastructure.Mqtt;
using MQFaker.Infrastructure.Persistence;

namespace MQFaker.Api;

public static class DependencyInjection
{
    public static IServiceCollection AddMqFaker(this IServiceCollection services)
    {
        // Tek MQTTnet client tüm istekler arasında paylaşılır (tek aktif bağlantı)
        services.AddSingleton<MqttnetClientProvider>();
        services.AddSingleton<IMqttConnectionManager, MqttnetConnectionManager>();
        services.AddSingleton<IMqttPublisher, MqttnetPublisher>();

        // Ayar yolu kayıt anında değil çözümleme anında okunur; böylece testler gibi
        // yapılandırmayı sonradan ekleyen barındırıcılar da geçerli değeri verebilir.
        services.AddSingleton<IConnectionSettingsStore>(sp =>
        {
            var config = sp.GetRequiredService<IConfiguration>();
            var path = config["MqFaker:SettingsPath"]
                ?? Path.Combine(AppContext.BaseDirectory, "connection-settings.json");
            return new JsonConnectionSettingsStore(path);
        });

        services.AddSingleton<ConnectionService>();
        services.AddSingleton<PublishService>();
        return services;
    }
}
