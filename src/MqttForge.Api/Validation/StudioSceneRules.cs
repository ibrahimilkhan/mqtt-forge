using System.Text.Json;
using MqttForge.Domain.Models;

namespace MqttForge.Api.Validation;

/// <summary>
/// What the server holds a scene to before keeping it: the envelope, not the 3D. The console owns
/// what a joint or a pose means; the server owns that the file is one it can list, name and collect
/// models for — and that nothing in it names a file outside the model folder.
/// </summary>
public static class StudioSceneRules
{
    public const int Version = 2;
    public const int NameMax = 120;

    public static Dictionary<string, string[]> Check(string routeId, JsonElement body)
    {
        var errors = new Dictionary<string, string[]>();
        void Add(string key, string message) => errors[key] = [message];

        if (body.ValueKind != JsonValueKind.Object)
        {
            Add("scene", "A scene is a JSON object.");
            return errors;
        }

        // The kind is asked first throughout: the JsonElement getters throw on the wrong kind, and a
        // body the client got wrong is a 400 that says where, not a 500 that says nothing.
        if (!body.TryGetProperty("version", out var version) || version.ValueKind != JsonValueKind.Number
            || !version.TryGetInt32(out var v) || v != Version)
            Add("version", $"Only version {Version} scenes are kept; an older file is imported by the console first.");

        if (!body.TryGetProperty("id", out var id) || id.ValueKind != JsonValueKind.String || id.GetString() != routeId)
            Add("id", "The scene's id has to be the one in the address.");

        if (!body.TryGetProperty("name", out var name) || name.ValueKind != JsonValueKind.String
            || string.IsNullOrWhiteSpace(name.GetString()) || name.GetString()!.Length > NameMax)
            Add("name", $"A scene needs a name of 1 to {NameMax} characters.");

        if (!body.TryGetProperty("objects", out var objects) || objects.ValueKind != JsonValueKind.Array)
        {
            Add("objects", "A scene's objects are a list.");
            return errors;
        }

        var index = 0;
        foreach (var item in objects.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object
                || !item.TryGetProperty("id", out var objectId) || objectId.ValueKind != JsonValueKind.String)
                Add($"objects[{index}]", "Every object needs a text id.");
            else if (item.TryGetProperty("model", out var model) && model.ValueKind == JsonValueKind.Object
                && (!model.TryGetProperty("key", out var key) || key.ValueKind != JsonValueKind.String
                    || !StudioIds.IsModelKey(key.GetString())))
                Add($"objects[{index}].model", "A model has to name a file the studio stored.");

            index++;
        }

        return errors;
    }
}
