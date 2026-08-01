using MQFaker.Api;

var app = MqFakerHost.Build(args);
app.Run();

// Exposed so integration tests can reach it through WebApplicationFactory
public partial class Program;
