using Microsoft.AspNetCore.Mvc;

namespace MQFaker.Api.Controllers;

// Reports the API process is up; says nothing about the broker
[ApiController]
[Route("api/health")]
public sealed class HealthController : ControllerBase
{
    [HttpGet]
    public IActionResult Get() => Ok(new { status = "ok" });
}
