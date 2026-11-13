# 3D Studio — Phase 1 (core + server persistence) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "3D Studio" panel in MQTT Forge where a user builds a scene of primitives, edits it with gizmos and an inspector, undoes and redoes, and has it saved on the server — the core of the DesignBox port.

**Architecture:** A framework-free `StudioEngine` (Babylon.js from npm) reconciles meshes against a zustand `studioStore` that holds a versioned scene document; React components (toolbar, outliner, inspector, scene menu) read and dispatch to the same store. Scenes are saved per file through a new `StudioController`; model blobs are content-addressed files. The panel is a lazy chunk exactly like Flows.

**Tech Stack:** React 19, TypeScript 6, zustand 5, TanStack Query 5, Vitest 4 + Testing Library + msw, `@babylonjs/core` 9.36 and `@babylonjs/materials` 9.36; ASP.NET Core on .NET 10, xUnit.

**Spec:** `docs/superpowers/specs/2026-11-13-3d-studio-design.md`

## Global Constraints

- Work only in the worktree `C:\IT\mqtt-forge-studio` on branch `feature/3d-studio`. Never push.
- Commits: one subject line, no body, conventional prefix, then plain lower-case prose saying what now holds and why (long subjects are normal). No attribution lines.
- Comments: say *why*, not what; British spelling ("colour", "normalised"), em-dashes, wrapped at ~100 columns. Match the surrounding comment density — every exported thing in this repo carries a prose comment.
- UI text is English. Labels: panel **"3D Studio"**, group **Tools**, `beta: true`.
- Babylon is imported from `@babylonjs/core` / `@babylonjs/materials` only, never from a CDN and never via `window.BABYLON`. No module in `features/studio/` touches `window.*` globals except `ResizeObserver` and `crypto.getRandomValues`.
- `web/tsconfig.app.json` has `erasableSyntaxOnly`, `noUnusedLocals` and `noUnusedParameters`: no constructor parameter properties (`constructor(private x)`), no enums, no namespaces; declare fields and assign them in the constructor.
- `crypto.randomUUID` is **not** allowed (the LAN address is not a secure context); ids come from `newId()` in `model/ids.ts`.
- No empty `catch {}`. No `innerHTML`. No `prompt()` / `confirm()` / `alert()`.
- Scene document `version` is `2`. DesignBox files are version `1` (or carry no version).
- Units: the scene is in metres; Euler angles are stored in radians; the UI shows lengths in the display unit and angles in degrees.
- Backend files follow the repo's `TreatWarningsAsErrors` — no unused usings, nullable clean.
- Unit-test runs in the worktree use `-p:SkipFrontend=true` (a fresh worktree would otherwise run `npm ci` inside `dotnet test`).
- Frontend tests: `cd web && npx vitest run <path>`; the whole suite: `cd web && npm test`.
- Deviations from the spec made here, on purpose: the only static-file mapping added is `.env` (models are served by the controller, not as static files); a `model` placeholder is a translucent grey box whose *inspector* says what it is (no in-scene text label — that would need `@babylonjs/gui` for one string); the lens view-shift DesignBox did through the private `_projectionMatrix` is dropped; parent links (`parentId`) are shown in the outliner but meshes are not parented until Phase 3.

---

## File map

**Backend (create)**
- `src/MqttForge.Domain/Models/StudioScene.cs` — `StudioSceneSummary`, `StudioSceneSet`, `StudioIds` (id/key rules)
- `src/MqttForge.Domain/Abstractions/IStudioSceneStore.cs`, `IStudioModelStore.cs`
- `src/MqttForge.Infrastructure/Persistence/JsonStudioSceneStore.cs` — one JSON file per scene
- `src/MqttForge.Infrastructure/Persistence/FileStudioModelStore.cs` — content-addressed model files + GC
- `src/MqttForge.Application/Services/StudioService.cs` — stamp, save, delete, collect unused models
- `src/MqttForge.Api/Validation/StudioSceneRules.cs` — shape checks for a PUT body
- `src/MqttForge.Api/Controllers/StudioController.cs`
- Tests: `tests/MqttForge.UnitTests/Infrastructure/JsonStudioSceneStoreTests.cs`, `FileStudioModelStoreTests.cs`, `tests/MqttForge.UnitTests/Application/StudioServiceTests.cs`, `tests/MqttForge.IntegrationTests/Api/StudioEndpointTests.cs`

**Backend (modify)**
- `src/MqttForge.Domain/Exceptions/MqttOperationException.cs` — two exceptions
- `src/MqttForge.Api/ErrorHandling/MqttExceptionHandler.cs` — their status and reason
- `src/MqttForge.Api/StorePaths.cs` — `Studio(config)`
- `src/MqttForge.Api/DependencyInjection.cs` — registrations
- `src/MqttForge.Api/MqttForgeHost.cs` — `.env` content type
- `tests/MqttForge.IntegrationTests/Support/MqttForgeApiFactory.cs` — own studio directory

**Frontend (create, under `web/src/features/studio/`)**
- `units/units.ts`, `units/evalExpr.ts` — display units, one formatter, expression parser
- `geometry/euler.ts`, `geometry/snap.ts` — angle wrapping, Euler→quaternion, snapping
- `model/document.ts`, `model/ids.ts`, `model/defaults.ts`, `model/sceneFile.ts`, `model/dataUrl.ts`
- `history.ts`, `studioStore.ts`
- `engine/primitives.ts`, `engine/materials.ts`, `engine/meshes.ts`, `engine/transform.ts`, `engine/camera.ts`, `engine/rendering.ts`, `engine/picking.ts`, `engine/gizmos.ts`, `engine/StudioEngine.ts`
- `useAutosave.ts`, `useStudioScene.ts`, `useStudioShortcuts.ts`
- `ui/NumberField.tsx`, `ui/Toolbar.tsx`, `ui/SceneMenu.tsx`, `ui/Outliner.tsx`, `ui/Inspector.tsx`, `ui/Viewport.tsx` (+ `.module.css` each where styled)
- `StudioPage.tsx` + `StudioPage.module.css`, `StudioPanel.tsx`
- `web/src/api/studio.ts`
- `web/public/studio/environment.env` (copied from `C:\IT\DesignBox\assets\environment.env`)
- Tests beside each module (`*.test.ts(x)`), fixture `model/fixtures/designbox-v1.json`

**Frontend (modify)**
- `web/package.json` — Babylon dependencies
- `web/src/api/queryKeys.ts`, `web/src/test/server.ts`
- `web/src/features/panels.ts`, `web/src/features/brand/icons.tsx`, `web/src/App.tsx`, `web/src/App.test.tsx`

---

### Task 0: Worktree ready

**Files:** none

- [ ] **Step 1: Install frontend packages in the worktree**

Run: `cd /c/IT/mqtt-forge-studio/web && npm ci`
Expected: completes without errors.

- [ ] **Step 2: Baseline — both suites pass before anything changes**

Run: `cd /c/IT/mqtt-forge-studio/web && npm test`
Expected: all tests pass.
Run: `cd /c/IT/mqtt-forge-studio && dotnet test tests/MqttForge.UnitTests -p:SkipFrontend=true`
Expected: all tests pass. If either baseline fails, stop and report — do not start on a red tree.

---

### Task 1: Scene store on disk (domain + infrastructure)

**Files:**
- Create: `src/MqttForge.Domain/Models/StudioScene.cs`
- Create: `src/MqttForge.Domain/Abstractions/IStudioSceneStore.cs`
- Modify: `src/MqttForge.Domain/Exceptions/MqttOperationException.cs` (append at end of file)
- Create: `src/MqttForge.Infrastructure/Persistence/JsonStudioSceneStore.cs`
- Test: `tests/MqttForge.UnitTests/Infrastructure/JsonStudioSceneStoreTests.cs`

**Interfaces:**
- Produces:
  - `record StudioSceneSummary(string Id, string Name, DateTimeOffset UpdatedAt)`
  - `record StudioSceneSet(IReadOnlyList<JsonElement> Documents, bool AnyUnreadable)`
  - `static class StudioIds { bool IsSceneId(string?); bool IsModelKey(string?); bool IsModelExtension(string?); IReadOnlySet<string> ModelExtensions }`
  - `interface IStudioSceneStore { Task<IReadOnlyList<StudioSceneSummary>> ListAsync(ct); Task<JsonElement?> GetAsync(string id, ct); Task SaveAsync(string id, JsonElement document, ct); Task<bool> DeleteAsync(string id, ct); Task<StudioSceneSet> ReadAllAsync(ct); }`
  - `StudioNotSavedException`, `StudioSceneUnreadableException` (both `: MqttOperationException`)
  - `JsonStudioSceneStore(string studioDirectory, ILogger<JsonStudioSceneStore>? log = null)` — files at `<studioDirectory>/scenes/<id>.json`

- [ ] **Step 1: Write the failing tests**

```csharp
// tests/MqttForge.UnitTests/Infrastructure/JsonStudioSceneStoreTests.cs
using System.Text.Json;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;
using MqttForge.Infrastructure.Persistence;

namespace MqttForge.UnitTests.Infrastructure;

public sealed class JsonStudioSceneStoreTests : IDisposable
{
    private readonly string _directory =
        Path.Combine(Path.GetTempPath(), $"mqttforge-studio-{Guid.NewGuid():N}");

    public void Dispose()
    {
        if (Directory.Exists(_directory)) Directory.Delete(_directory, recursive: true);
    }

    private static JsonElement Scene(string id, string name = "Cell 1", string updatedAt = "2026-11-13T10:00:00+00:00") =>
        JsonSerializer.SerializeToElement(new { version = 2, id, name, updatedAt, objects = Array.Empty<object>() });

    [Fact]
    public async Task No_directory_lists_no_scenes()
    {
        Assert.Empty(await new JsonStudioSceneStore(_directory).ListAsync(CancellationToken.None));
    }

    [Fact]
    public async Task A_saved_scene_comes_back_as_it_went_in_and_is_listed()
    {
        var store = new JsonStudioSceneStore(_directory);

        await store.SaveAsync("a1", Scene("a1"), CancellationToken.None);

        var back = await store.GetAsync("a1", CancellationToken.None);
        Assert.NotNull(back);
        Assert.Equal("Cell 1", back.Value.GetProperty("name").GetString());
        var summary = Assert.Single(await store.ListAsync(CancellationToken.None));
        Assert.Equal(new StudioSceneSummary("a1", "Cell 1", DateTimeOffset.Parse("2026-11-13T10:00:00+00:00")), summary);
        Assert.True(File.Exists(Path.Combine(_directory, "scenes", "a1.json")));
        Assert.False(File.Exists(Path.Combine(_directory, "scenes", "a1.json.tmp")));
    }

    [Fact]
    public async Task An_unknown_scene_is_null_and_deleting_it_is_false()
    {
        var store = new JsonStudioSceneStore(_directory);

        Assert.Null(await store.GetAsync("nope", CancellationToken.None));
        Assert.False(await store.DeleteAsync("nope", CancellationToken.None));
    }

    [Fact]
    public async Task Deleting_a_scene_removes_its_file()
    {
        var store = new JsonStudioSceneStore(_directory);
        await store.SaveAsync("a1", Scene("a1"), CancellationToken.None);

        Assert.True(await store.DeleteAsync("a1", CancellationToken.None));
        Assert.Null(await store.GetAsync("a1", CancellationToken.None));
    }

    [Fact]
    public async Task A_broken_file_is_left_out_of_the_list_and_marks_the_set_unreadable()
    {
        var store = new JsonStudioSceneStore(_directory);
        await store.SaveAsync("good", Scene("good"), CancellationToken.None);
        await File.WriteAllTextAsync(Path.Combine(_directory, "scenes", "bad.json"), "{ not json");

        var listed = await store.ListAsync(CancellationToken.None);
        var all = await store.ReadAllAsync(CancellationToken.None);

        Assert.Equal("good", Assert.Single(listed).Id);
        Assert.Single(all.Documents);
        Assert.True(all.AnyUnreadable);
    }

    [Fact]
    public async Task Reading_a_broken_scene_says_so_rather_than_answering_nothing()
    {
        Directory.CreateDirectory(Path.Combine(_directory, "scenes"));
        await File.WriteAllTextAsync(Path.Combine(_directory, "scenes", "bad.json"), "{ not json");

        await Assert.ThrowsAsync<StudioSceneUnreadableException>(
            () => new JsonStudioSceneStore(_directory).GetAsync("bad", CancellationToken.None));
    }

    [Theory]
    [InlineData("../escape")]
    [InlineData("a/b")]
    [InlineData("")]
    public async Task An_id_that_could_leave_the_folder_is_refused(string id)
    {
        await Assert.ThrowsAsync<ArgumentException>(
            () => new JsonStudioSceneStore(_directory).SaveAsync(id, Scene("x"), CancellationToken.None));
    }

    [Theory]
    [InlineData("abc_DEF-123", true)]
    [InlineData("../x", false)]
    [InlineData(null, false)]
    public void Scene_ids_are_a_safe_file_name(string? id, bool expected) =>
        Assert.Equal(expected, StudioIds.IsSceneId(id));

    [Theory]
    [InlineData("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.glb", true)]
    [InlineData("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.exe", false)]
    [InlineData("../0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.glb", false)]
    public void Model_keys_are_a_hash_and_a_known_extension(string key, bool expected) =>
        Assert.Equal(expected, StudioIds.IsModelKey(key));
}
```

- [ ] **Step 2: Run to see them fail**

Run: `cd /c/IT/mqtt-forge-studio && dotnet test tests/MqttForge.UnitTests -p:SkipFrontend=true --filter "FullyQualifiedName~JsonStudioSceneStoreTests"`
Expected: build FAIL — `JsonStudioSceneStore`, `StudioIds` not found.

- [ ] **Step 3: Domain types**

```csharp
// src/MqttForge.Domain/Models/StudioScene.cs
using System.Text.Json;
using System.Text.RegularExpressions;

namespace MqttForge.Domain.Models;

/// <summary>What the scene list shows: enough to pick one without reading every file whole.</summary>
public sealed record StudioSceneSummary(string Id, string Name, DateTimeOffset UpdatedAt);

/// <summary>
/// Every scene that could be read, and whether any could not. The second half is what keeps model
/// collection honest: a scene that cannot be read still owns its models, and nobody can say which.
/// </summary>
public sealed record StudioSceneSet(IReadOnlyList<JsonElement> Documents, bool AnyUnreadable);

/// <summary>
/// The two names the studio turns into file names. Both are checked here, once, because both arrive
/// from a URL — and a scene id of <c>../connection-settings</c> would otherwise be a path.
/// </summary>
public static partial class StudioIds
{
    /// <summary>The model formats the studio stores. Phase 1 stores them; Phase 2 learns to draw them.</summary>
    public static readonly IReadOnlySet<string> ModelExtensions =
        new HashSet<string>(StringComparer.Ordinal) { ".glb", ".gltf", ".stl", ".obj", ".dbmesh", ".step", ".stp", ".iges", ".igs" };

    public static bool IsSceneId(string? id) => id is not null && SceneId().IsMatch(id);

    // The key is the file's SHA-256 and its extension, so it says what the file is and nothing a
    // caller could steer: no separators, no dots before the extension.
    public static bool IsModelKey(string? key) =>
        key is not null && ModelKey().IsMatch(key) && ModelExtensions.Contains(Path.GetExtension(key));

    public static bool IsModelExtension(string? extension) =>
        extension is not null && ModelExtensions.Contains(extension);

    [GeneratedRegex("^[A-Za-z0-9_-]{1,64}$")]
    private static partial Regex SceneId();

    [GeneratedRegex("^[0-9a-f]{64}\\.[a-z]{3,6}$")]
    private static partial Regex ModelKey();
}
```

```csharp
// src/MqttForge.Domain/Abstractions/IStudioSceneStore.cs
using System.Text.Json;
using MqttForge.Domain.Models;

namespace MqttForge.Domain.Abstractions;

/// <summary>Where the 3D Studio's scenes are kept: one document per scene, read and written whole.</summary>
// Per scene rather than one file for all of them, for the reason IFlowStore is per flow: a phone and
// a desk editing two different scenes must not have the second save take the first one's work away.
// The document is kept as JSON the server does not interpret beyond its id, name and model keys —
// what a joint or a pose means is the console's business, and a newer console's fields survive an
// older server untouched.
public interface IStudioSceneStore
{
    /// <summary>The readable scenes, newest first is the caller's choice; files that will not parse are left out and logged.</summary>
    Task<IReadOnlyList<StudioSceneSummary>> ListAsync(CancellationToken ct);

    /// <summary>The scene, or null when there is none by that id.</summary>
    /// <exception cref="Exceptions.StudioSceneUnreadableException">The file is there and will not parse.</exception>
    Task<JsonElement?> GetAsync(string id, CancellationToken ct);

    /// <exception cref="Exceptions.StudioNotSavedException">The file could not be written.</exception>
    Task SaveAsync(string id, JsonElement document, CancellationToken ct);

    /// <summary>False when no scene had that id.</summary>
    Task<bool> DeleteAsync(string id, CancellationToken ct);

    Task<StudioSceneSet> ReadAllAsync(CancellationToken ct);
}
```

Append to `src/MqttForge.Domain/Exceptions/MqttOperationException.cs`:

```csharp
// A studio scene or model could not be written down. Its own type for the reason the flows have
// theirs: the sentence the reader is shown names the thing they were editing.
public sealed class StudioNotSavedException : MqttOperationException
{
    public StudioNotSavedException(string message, Exception? inner = null)
        : base(message, inner) { }
}

// A scene file is there and will not parse. A 409 like the flows' twin: nothing failed on the way
// in, the state of the file is what is in the way, and saving over it would lose whatever it held.
public sealed class StudioSceneUnreadableException : MqttOperationException
{
    public StudioSceneUnreadableException(string message, Exception? inner = null)
        : base(message, inner) { }
}
```

- [ ] **Step 4: The store**

```csharp
// src/MqttForge.Infrastructure/Persistence/JsonStudioSceneStore.cs
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;

namespace MqttForge.Infrastructure.Persistence;

// Write mechanics are JsonFlowStore's — a temporary file, then a swap — so an interrupted write
// cannot leave half a scene behind. One file per scene, so a broken one costs that scene and not
// the folder: the list goes on without it, and opening it says why it cannot be opened.
public sealed class JsonStudioSceneStore : IStudioSceneStore
{
    private readonly string _directory;
    private readonly ILogger _log;

    // Two saves of one scene from two consoles would otherwise race on the same .tmp file.
    private readonly SemaphoreSlim _gate = new(1, 1);

    public JsonStudioSceneStore(string studioDirectory, ILogger<JsonStudioSceneStore>? log = null)
    {
        _directory = Path.Combine(studioDirectory, "scenes");
        _log = (ILogger?)log ?? NullLogger.Instance;
    }

    public async Task<IReadOnlyList<StudioSceneSummary>> ListAsync(CancellationToken ct)
    {
        var all = await ReadAllAsync(ct);
        var summaries = new List<StudioSceneSummary>(all.Documents.Count);

        foreach (var document in all.Documents)
            summaries.Add(new StudioSceneSummary(
                document.GetProperty("id").GetString()!,
                document.GetProperty("name").GetString()!,
                document.TryGetProperty("updatedAt", out var at) && at.TryGetDateTimeOffset(out var when)
                    ? when
                    : DateTimeOffset.MinValue));

        return summaries;
    }

    public async Task<JsonElement?> GetAsync(string id, CancellationToken ct)
    {
        var path = PathOf(id);
        if (!File.Exists(path)) return null;

        return await ReadAsync(path, ct)
            ?? throw new StudioSceneUnreadableException(
                $"The scene file {path} could not be read. Repair it or move it aside; it will not be written over until then.");
    }

    public async Task SaveAsync(string id, JsonElement document, CancellationToken ct)
    {
        var path = PathOf(id);
        var temp = path + ".tmp";

        await _gate.WaitAsync(ct);
        try
        {
            Directory.CreateDirectory(_directory);
            await using (var stream = File.Create(temp))
                await JsonSerializer.SerializeAsync(stream, document, cancellationToken: ct);

            File.Move(temp, path, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new StudioNotSavedException($"Could not write the scene to {path}: {ex.Message}", ex);
        }
        finally
        {
            _gate.Release();
        }
    }

    public Task<bool> DeleteAsync(string id, CancellationToken ct)
    {
        var path = PathOf(id);
        if (!File.Exists(path)) return Task.FromResult(false);

        try
        {
            File.Delete(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new StudioNotSavedException($"Could not delete the scene {path}: {ex.Message}", ex);
        }

        return Task.FromResult(true);
    }

    public async Task<StudioSceneSet> ReadAllAsync(CancellationToken ct)
    {
        if (!Directory.Exists(_directory)) return new StudioSceneSet([], AnyUnreadable: false);

        var documents = new List<JsonElement>();
        var anyUnreadable = false;

        foreach (var path in Directory.EnumerateFiles(_directory, "*.json"))
        {
            var document = await ReadAsync(path, ct);
            if (document is null)
            {
                anyUnreadable = true;
                _log.LogWarning("The studio scene {Path} could not be read and is left out of the list.", path);
                continue;
            }

            documents.Add(document.Value);
        }

        return new StudioSceneSet(documents, anyUnreadable);
    }

    // Null for a file that does not parse, or parses into something that is not a scene this store
    // wrote: an object with a string id matching its own file name and a string name.
    private static async Task<JsonElement?> ReadAsync(string path, CancellationToken ct)
    {
        try
        {
            await using var stream = File.OpenRead(path);
            using var parsed = await JsonDocument.ParseAsync(stream, cancellationToken: ct);
            var root = parsed.RootElement;

            var whole = root.ValueKind == JsonValueKind.Object
                && root.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String
                && id.GetString() == Path.GetFileNameWithoutExtension(path)
                && root.TryGetProperty("name", out var name) && name.ValueKind == JsonValueKind.String;

            return whole ? root.Clone() : null;
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private string PathOf(string id) =>
        StudioIds.IsSceneId(id)
            ? Path.Combine(_directory, id + ".json")
            : throw new ArgumentException($"'{id}' is not a scene id.", nameof(id));
}
```

- [ ] **Step 5: Run the tests**

Run: `cd /c/IT/mqtt-forge-studio && dotnet test tests/MqttForge.UnitTests -p:SkipFrontend=true --filter "FullyQualifiedName~JsonStudioSceneStoreTests"`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
cd /c/IT/mqtt-forge-studio
git add src/MqttForge.Domain src/MqttForge.Infrastructure/Persistence/JsonStudioSceneStore.cs tests/MqttForge.UnitTests/Infrastructure/JsonStudioSceneStoreTests.cs
git commit -m "feat: studio scenes are kept one json file each beside the console's other settings, written through a swap so a crash cannot halve one, and a broken file costs its own scene rather than the list"
```

---

### Task 2: Model files on disk

**Files:**
- Create: `src/MqttForge.Domain/Abstractions/IStudioModelStore.cs`
- Create: `src/MqttForge.Infrastructure/Persistence/FileStudioModelStore.cs`
- Test: `tests/MqttForge.UnitTests/Infrastructure/FileStudioModelStoreTests.cs`

**Interfaces:**
- Consumes: `StudioIds`, `StudioNotSavedException` (Task 1)
- Produces:
  - `interface IStudioModelStore { Task<string> PutAsync(Stream content, string extension, CancellationToken ct); Stream? OpenRead(string key); int DeleteUnused(IReadOnlySet<string> keep, TimeSpan grace); }`
  - `FileStudioModelStore(string studioDirectory, TimeProvider? time = null)` — files at `<studioDirectory>/models/<sha256><ext>`

- [ ] **Step 1: Write the failing tests**

```csharp
// tests/MqttForge.UnitTests/Infrastructure/FileStudioModelStoreTests.cs
using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Time.Testing;
using MqttForge.Infrastructure.Persistence;

namespace MqttForge.UnitTests.Infrastructure;

public sealed class FileStudioModelStoreTests : IDisposable
{
    private readonly string _directory =
        Path.Combine(Path.GetTempPath(), $"mqttforge-models-{Guid.NewGuid():N}");

    public void Dispose()
    {
        if (Directory.Exists(_directory)) Directory.Delete(_directory, recursive: true);
    }

    private static MemoryStream Bytes(string text) => new(Encoding.UTF8.GetBytes(text));

    private static string Hash(string text) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)));

    [Fact]
    public async Task A_stored_file_is_named_by_its_hash_and_reads_back()
    {
        var store = new FileStudioModelStore(_directory);

        var key = await store.PutAsync(Bytes("solid cube"), ".stl", CancellationToken.None);

        Assert.Equal(Hash("solid cube") + ".stl", key);
        using var read = store.OpenRead(key);
        Assert.NotNull(read);
        Assert.Equal("solid cube", await new StreamReader(read).ReadToEndAsync());
    }

    [Fact]
    public async Task The_same_file_twice_is_stored_once()
    {
        var store = new FileStudioModelStore(_directory);

        var first = await store.PutAsync(Bytes("same"), ".glb", CancellationToken.None);
        var second = await store.PutAsync(Bytes("same"), ".glb", CancellationToken.None);

        Assert.Equal(first, second);
        Assert.Single(Directory.GetFiles(Path.Combine(_directory, "models")));
    }

    [Fact]
    public async Task An_extension_it_does_not_keep_is_refused()
    {
        await Assert.ThrowsAsync<ArgumentException>(
            () => new FileStudioModelStore(_directory).PutAsync(Bytes("x"), ".exe", CancellationToken.None));
    }

    [Fact]
    public void A_key_that_is_not_one_opens_nothing()
    {
        Assert.Null(new FileStudioModelStore(_directory).OpenRead("../../connection-settings.json"));
    }

    [Fact]
    public async Task Unused_files_go_once_they_are_older_than_the_grace_and_kept_ones_stay()
    {
        var time = new FakeTimeProvider(DateTimeOffset.UtcNow);
        var store = new FileStudioModelStore(_directory, time);
        var kept = await store.PutAsync(Bytes("kept"), ".glb", CancellationToken.None);
        var unused = await store.PutAsync(Bytes("unused"), ".glb", CancellationToken.None);

        // A file just uploaded may be about to be named by a scene save still on its way.
        Assert.Equal(0, store.DeleteUnused(new HashSet<string> { kept }, TimeSpan.FromHours(1)));

        time.Advance(TimeSpan.FromHours(2));
        Assert.Equal(1, store.DeleteUnused(new HashSet<string> { kept }, TimeSpan.FromHours(1)));
        Assert.NotNull(store.OpenRead(kept));
        Assert.Null(store.OpenRead(unused));
    }
}
```

Check `Microsoft.Extensions.TimeProvider.Testing` is referenced by the unit-test project: `grep -n TimeProvider.Testing tests/MqttForge.UnitTests/MqttForge.UnitTests.csproj`. If it is not, add `<PackageReference Include="Microsoft.Extensions.TimeProvider.Testing" Version="10.0.0" />` to that csproj's package `ItemGroup`.

- [ ] **Step 2: Run to see them fail**

Run: `cd /c/IT/mqtt-forge-studio && dotnet test tests/MqttForge.UnitTests -p:SkipFrontend=true --filter "FullyQualifiedName~FileStudioModelStoreTests"`
Expected: build FAIL — `FileStudioModelStore` not found.

- [ ] **Step 3: Interface and store**

```csharp
// src/MqttForge.Domain/Abstractions/IStudioModelStore.cs
namespace MqttForge.Domain.Abstractions;

/// <summary>
/// The model files studio scenes point at, kept apart from the scenes so a scene save is a few
/// kilobytes of JSON rather than the whole of every part in it, base64'd.
/// </summary>
// Content-addressed: the key is the file's hash, so the same part dropped into ten scenes is one
// file, and a key can be cached for good by whoever reads it — what it names can never change.
public interface IStudioModelStore
{
    /// <summary>Stores the bytes and answers their key.</summary>
    /// <exception cref="ArgumentException">The extension is not one the studio keeps.</exception>
    /// <exception cref="Exceptions.StudioNotSavedException">The file could not be written.</exception>
    Task<string> PutAsync(Stream content, string extension, CancellationToken ct);

    /// <summary>The file, or null when the key is not one or nothing is stored under it.</summary>
    Stream? OpenRead(string key);

    /// <summary>Deletes every stored file not in <paramref name="keep"/> and older than <paramref name="grace"/>; answers how many went.</summary>
    int DeleteUnused(IReadOnlySet<string> keep, TimeSpan grace);
}
```

```csharp
// src/MqttForge.Infrastructure/Persistence/FileStudioModelStore.cs
using System.Security.Cryptography;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;

namespace MqttForge.Infrastructure.Persistence;

public sealed class FileStudioModelStore : IStudioModelStore
{
    private const int BufferBytes = 81920;

    private readonly string _directory;
    private readonly TimeProvider _time;

    public FileStudioModelStore(string studioDirectory, TimeProvider? time = null)
    {
        _directory = Path.Combine(studioDirectory, "models");
        _time = time ?? TimeProvider.System;
    }

    public async Task<string> PutAsync(Stream content, string extension, CancellationToken ct)
    {
        var ext = extension.ToLowerInvariant();
        if (!StudioIds.IsModelExtension(ext))
            throw new ArgumentException($"'{extension}' is not a model format the studio keeps.", nameof(extension));

        // Written under a name of its own first, because the name it ends up under is not known
        // until the last byte has been hashed.
        var temp = Path.Combine(_directory, $"upload-{Guid.NewGuid():N}.tmp");
        try
        {
            Directory.CreateDirectory(_directory);
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            var buffer = new byte[BufferBytes];

            await using (var file = File.Create(temp))
            {
                int read;
                while ((read = await content.ReadAsync(buffer, ct)) > 0)
                {
                    hash.AppendData(buffer, 0, read);
                    await file.WriteAsync(buffer.AsMemory(0, read), ct);
                }
            }

            var key = Convert.ToHexStringLower(hash.GetHashAndReset()) + ext;
            var target = Path.Combine(_directory, key);

            if (File.Exists(target))
            {
                File.Delete(temp);
                // Touched, so the grace in DeleteUnused counts from this upload and not the first:
                // the scene about to name it again has not been saved yet.
                File.SetLastWriteTimeUtc(target, _time.GetUtcNow().UtcDateTime);
            }
            else
            {
                File.Move(temp, target);
                File.SetLastWriteTimeUtc(target, _time.GetUtcNow().UtcDateTime);
            }

            return key;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            if (File.Exists(temp)) File.Delete(temp);
            throw new StudioNotSavedException($"Could not store the model in {_directory}: {ex.Message}", ex);
        }
    }

    public Stream? OpenRead(string key)
    {
        if (!StudioIds.IsModelKey(key)) return null;

        var path = Path.Combine(_directory, key);
        return File.Exists(path) ? File.OpenRead(path) : null;
    }

    public int DeleteUnused(IReadOnlySet<string> keep, TimeSpan grace)
    {
        if (!Directory.Exists(_directory)) return 0;

        var cutoff = _time.GetUtcNow().UtcDateTime - grace;
        var deleted = 0;

        foreach (var path in Directory.EnumerateFiles(_directory))
        {
            var name = Path.GetFileName(path);
            // Only files this store named. An upload half written is someone's request in flight.
            if (!StudioIds.IsModelKey(name) || keep.Contains(name)) continue;
            if (File.GetLastWriteTimeUtc(path) > cutoff) continue;

            File.Delete(path);
            deleted++;
        }

        return deleted;
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd /c/IT/mqtt-forge-studio && dotnet test tests/MqttForge.UnitTests -p:SkipFrontend=true --filter "FullyQualifiedName~FileStudioModelStoreTests"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /c/IT/mqtt-forge-studio
git add src/MqttForge.Domain/Abstractions/IStudioModelStore.cs src/MqttForge.Infrastructure/Persistence/FileStudioModelStore.cs tests/MqttForge.UnitTests
git commit -m "feat: studio model files are stored once each under their own hash, so a part used in ten scenes is one file and a fresh upload is not collected before the scene naming it is saved"
```

---

### Task 3: Studio service — stamping, saving, collecting

**Files:**
- Create: `src/MqttForge.Application/Services/StudioService.cs`
- Test: `tests/MqttForge.UnitTests/Application/StudioServiceTests.cs`

**Interfaces:**
- Consumes: `IStudioSceneStore`, `IStudioModelStore` (Tasks 1–2)
- Produces: `StudioService(IStudioSceneStore scenes, IStudioModelStore models, ILogger<StudioService> log)` with
  `ListAsync(ct)`, `GetAsync(id, ct)`, `SaveAsync(string id, JsonElement document, DateTimeOffset now, ct)`, `DeleteAsync(id, ct) → bool`, `PutModelAsync(Stream, string ext, ct) → string`, `OpenModel(string key) → Stream?`, `static IEnumerable<string> ModelKeys(JsonElement)`, `static readonly TimeSpan UploadGrace` (1 h)

- [ ] **Step 1: Write the failing tests**

```csharp
// tests/MqttForge.UnitTests/Application/StudioServiceTests.cs
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using MqttForge.Application.Services;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Models;

namespace MqttForge.UnitTests.Application;

public sealed class StudioServiceTests
{
    private const string KeyA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.glb";
    private const string KeyB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.stl";

    private static JsonElement Scene(string id, params string[] modelKeys) => JsonSerializer.SerializeToElement(new
    {
        version = 2,
        id,
        name = "Cell",
        updatedAt = "2000-01-01T00:00:00+00:00",
        objects = modelKeys.Select((key, i) => new { id = $"o{i}", type = "model", model = new { key, ext = Path.GetExtension(key) } }),
    });

    private sealed class Scenes : IStudioSceneStore
    {
        public readonly Dictionary<string, JsonElement> Saved = [];
        public bool Unreadable;

        public Task<IReadOnlyList<StudioSceneSummary>> ListAsync(CancellationToken ct) => throw new NotSupportedException();
        public Task<JsonElement?> GetAsync(string id, CancellationToken ct) =>
            Task.FromResult(Saved.TryGetValue(id, out var d) ? d : (JsonElement?)null);
        public Task SaveAsync(string id, JsonElement document, CancellationToken ct) { Saved[id] = document; return Task.CompletedTask; }
        public Task<bool> DeleteAsync(string id, CancellationToken ct) => Task.FromResult(Saved.Remove(id));
        public Task<StudioSceneSet> ReadAllAsync(CancellationToken ct) => Task.FromResult(new StudioSceneSet([.. Saved.Values], Unreadable));
    }

    private sealed class Models : IStudioModelStore
    {
        public IReadOnlySet<string>? Kept;
        public Task<string> PutAsync(Stream content, string extension, CancellationToken ct) => Task.FromResult(KeyA);
        public Stream? OpenRead(string key) => null;
        public int DeleteUnused(IReadOnlySet<string> keep, TimeSpan grace) { Kept = keep; return 0; }
    }

    [Fact]
    public async Task A_save_is_stamped_with_the_server_s_time_not_the_console_s()
    {
        var scenes = new Scenes();
        var service = new StudioService(scenes, new Models(), NullLogger<StudioService>.Instance);
        var now = new DateTimeOffset(2026, 11, 13, 12, 0, 0, TimeSpan.Zero);

        await service.SaveAsync("s1", Scene("s1"), now, CancellationToken.None);

        Assert.Equal(now, scenes.Saved["s1"].GetProperty("updatedAt").GetDateTimeOffset());
        Assert.Equal("Cell", scenes.Saved["s1"].GetProperty("name").GetString());
    }

    [Fact]
    public async Task Every_model_any_scene_names_is_kept_when_collecting()
    {
        var scenes = new Scenes();
        var models = new Models();
        var service = new StudioService(scenes, models, NullLogger<StudioService>.Instance);

        await service.SaveAsync("s1", Scene("s1", KeyA), DateTimeOffset.UtcNow, CancellationToken.None);
        await service.SaveAsync("s2", Scene("s2", KeyB), DateTimeOffset.UtcNow, CancellationToken.None);

        Assert.Equal(new HashSet<string> { KeyA, KeyB }, models.Kept);
    }

    [Fact]
    public async Task Nothing_is_collected_while_any_scene_cannot_be_read()
    {
        var scenes = new Scenes { Unreadable = true };
        var models = new Models();
        var service = new StudioService(scenes, models, NullLogger<StudioService>.Instance);

        await service.SaveAsync("s1", Scene("s1"), DateTimeOffset.UtcNow, CancellationToken.None);

        Assert.Null(models.Kept);
    }

    [Fact]
    public async Task Deleting_a_scene_collects_and_says_whether_there_was_one()
    {
        var scenes = new Scenes();
        var models = new Models();
        var service = new StudioService(scenes, models, NullLogger<StudioService>.Instance);
        await service.SaveAsync("s1", Scene("s1", KeyA), DateTimeOffset.UtcNow, CancellationToken.None);

        Assert.True(await service.DeleteAsync("s1", CancellationToken.None));
        Assert.Empty(models.Kept!);
        Assert.False(await service.DeleteAsync("s1", CancellationToken.None));
    }

    [Fact]
    public void Model_keys_skip_objects_without_a_model_and_odd_shapes()
    {
        var document = JsonSerializer.SerializeToElement(new
        {
            objects = new object[]
            {
                new { id = "a", type = "box" },
                new { id = "b", type = "model", model = new { key = KeyA } },
                new { id = "c", type = "model", model = "not an object" },
            },
        });

        Assert.Equal([KeyA], StudioService.ModelKeys(document));
    }
}
```

- [ ] **Step 2: Run to see them fail**

Run: `cd /c/IT/mqtt-forge-studio && dotnet test tests/MqttForge.UnitTests -p:SkipFrontend=true --filter "FullyQualifiedName~StudioServiceTests"`
Expected: build FAIL — `StudioService` not found.

- [ ] **Step 3: The service**

```csharp
// src/MqttForge.Application/Services/StudioService.cs
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Models;

namespace MqttForge.Application.Services;

/// <summary>The 3D Studio's scenes and the model files they point at.</summary>
public sealed class StudioService
{
    /// <summary>
    /// How long an upload nobody names yet is kept. A console uploads a part and saves the scene
    /// naming it a moment later; a collection run from another console's save in between must not
    /// take the part away.
    /// </summary>
    public static readonly TimeSpan UploadGrace = TimeSpan.FromHours(1);

    private readonly IStudioSceneStore _scenes;
    private readonly IStudioModelStore _models;
    private readonly ILogger<StudioService> _log;

    public StudioService(IStudioSceneStore scenes, IStudioModelStore models, ILogger<StudioService> log)
    {
        _scenes = scenes;
        _models = models;
        _log = log;
    }

    public Task<IReadOnlyList<StudioSceneSummary>> ListAsync(CancellationToken ct) => _scenes.ListAsync(ct);

    public Task<JsonElement?> GetAsync(string id, CancellationToken ct) => _scenes.GetAsync(id, ct);

    /// <summary>Keeps the scene, stamped with <paramref name="now"/>, then drops models no scene names.</summary>
    // The server's clock and not the console's: two consoles on two machines sort the list by this.
    public async Task SaveAsync(string id, JsonElement document, DateTimeOffset now, CancellationToken ct)
    {
        var stamped = JsonNode.Parse(document.GetRawText())!.AsObject();
        stamped["updatedAt"] = now.ToString("O");

        await _scenes.SaveAsync(id, JsonSerializer.SerializeToElement(stamped), ct);
        await CollectAsync(ct);
    }

    public async Task<bool> DeleteAsync(string id, CancellationToken ct)
    {
        if (!await _scenes.DeleteAsync(id, ct)) return false;

        await CollectAsync(ct);
        return true;
    }

    public Task<string> PutModelAsync(Stream content, string extension, CancellationToken ct) =>
        _models.PutAsync(content, extension, ct);

    public Stream? OpenModel(string key) => _models.OpenRead(key);

    /// <summary>The model keys a scene document names, read leniently: anything not shaped like one is not one.</summary>
    public static IEnumerable<string> ModelKeys(JsonElement document)
    {
        if (!document.TryGetProperty("objects", out var objects) || objects.ValueKind != JsonValueKind.Array) yield break;

        foreach (var item in objects.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.Object
                && item.TryGetProperty("model", out var model) && model.ValueKind == JsonValueKind.Object
                && model.TryGetProperty("key", out var key) && key.ValueKind == JsonValueKind.String)
                yield return key.GetString()!;
        }
    }

    // A failure here is logged and not thrown: the scene the reader asked to save was saved, and a
    // model file left over until the next save costs disk, not work.
    private async Task CollectAsync(CancellationToken ct)
    {
        var all = await _scenes.ReadAllAsync(ct);
        // A scene that cannot be read still owns models, and which ones cannot be told.
        if (all.AnyUnreadable) return;

        var keep = new HashSet<string>(all.Documents.SelectMany(ModelKeys), StringComparer.Ordinal);
        try
        {
            _models.DeleteUnused(keep, UploadGrace);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _log.LogWarning(ex, "Unused studio models could not be collected; they will be tried again on the next save.");
        }
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd /c/IT/mqtt-forge-studio && dotnet test tests/MqttForge.UnitTests -p:SkipFrontend=true --filter "FullyQualifiedName~StudioServiceTests"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /c/IT/mqtt-forge-studio
git add src/MqttForge.Application/Services/StudioService.cs tests/MqttForge.UnitTests/Application/StudioServiceTests.cs
git commit -m "feat: a studio save is stamped with the server's clock and followed by a sweep of models no scene names, skipped whole while any scene cannot be read because that scene's models cannot be told apart"
```

---

### Task 4: Studio API endpoints

**Files:**
- Create: `src/MqttForge.Api/Validation/StudioSceneRules.cs`
- Create: `src/MqttForge.Api/Controllers/StudioController.cs`
- Modify: `src/MqttForge.Api/StorePaths.cs` (add constant + method beside `Flows`)
- Modify: `src/MqttForge.Api/DependencyInjection.cs:203` (after `services.AddSingleton<FlowService>();`)
- Modify: `src/MqttForge.Api/ErrorHandling/MqttExceptionHandler.cs` (two arms in each `switch`, after the flows' arms)
- Modify: `src/MqttForge.Api/MqttForgeHost.cs:143` (`UseStaticFiles`)
- Modify: `tests/MqttForge.IntegrationTests/Support/MqttForgeApiFactory.cs`
- Test: `tests/MqttForge.IntegrationTests/Api/StudioEndpointTests.cs`

**Interfaces:**
- Consumes: `StudioService` (Task 3)
- Produces (HTTP, consumed by Task 8's `web/src/api/studio.ts`):
  - `GET /api/studio/scenes` → `200 [{id, name, updatedAt}]`
  - `GET /api/studio/scenes/{id}` → `200` raw scene JSON · `404 {reason:'sceneUnknown'}` · `409 {reason:'sceneUnreadable'}`
  - `PUT /api/studio/scenes/{id}` (JSON body ≤ 8 MB) → `204` · `400 ValidationProblemDetails {reason:'sceneInvalid'}` · `500 {reason:'studioNotSaved'}`
  - `DELETE /api/studio/scenes/{id}` → `204` · `404 {reason:'sceneUnknown'}`
  - `POST /api/studio/models?ext=.glb` (raw body ≤ 200 MB) → `200 {key}` · `400 {reason:'modelInvalid'}`
  - `GET /api/studio/models/{key}` → `200` file, `Cache-Control: public, max-age=31536000, immutable`, `ETag` · `404 {reason:'modelUnknown'}`

- [ ] **Step 1: Give the test factory its own studio folder**

In `tests/MqttForge.IntegrationTests/Support/MqttForgeApiFactory.cs`:
- add a field `private readonly string _studioPath;` after `_flowsPath`;
- in **both** constructors, after the `_flowsPath = ...` line, add `_studioPath = Own("api-studio");`;
- add `public string StudioPath => _studioPath;` after `FlowsPath`;
- in `ConfigureWebHost`'s dictionary, after the `FlowsPath` entry, add `["MqttForge:StudioPath"] = _studioPath,`.

- [ ] **Step 2: Write the failing integration tests**

```csharp
// tests/MqttForge.IntegrationTests/Api/StudioEndpointTests.cs
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MqttForge.IntegrationTests.Support;
using Xunit;

namespace MqttForge.IntegrationTests.Api;

// No broker: the studio never needs one.
public sealed class StudioEndpointTests : IClassFixture<MqttForgeApiFactory>
{
    private readonly MqttForgeApiFactory _factory;
    private readonly HttpClient _client;

    public StudioEndpointTests(MqttForgeApiFactory factory)
    {
        _factory = factory;
        _client = factory.CreateClient();
    }

    private static object Scene(string id, string name = "Cell 1", object[]? objects = null) => new
    {
        version = 2,
        id,
        name,
        updatedAt = "2000-01-01T00:00:00Z",
        settings = new { displayUnit = "mm", moveStep = 0.001, rotateStep = 1, snap = true },
        objects = objects ?? [new { id = "o1", type = "box", name = "Box", position = new[] { 0, 0.5, 0 } }],
        groups = Array.Empty<object>(),
        poses = Array.Empty<object>(),
        annotations = Array.Empty<object>(),
    };

    private static async Task<JsonElement> Json(HttpResponseMessage response) =>
        JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.Clone();

    [Fact]
    public async Task A_saved_scene_is_listed_and_reads_back_with_a_server_stamp()
    {
        var put = await _client.PutAsJsonAsync("/api/studio/scenes/round1", Scene("round1"));
        Assert.Equal(HttpStatusCode.NoContent, put.StatusCode);

        var list = await Json(await _client.GetAsync("/api/studio/scenes"));
        var listed = list.EnumerateArray().Single(one => one.GetProperty("id").GetString() == "round1");
        Assert.Equal("Cell 1", listed.GetProperty("name").GetString());

        var scene = await Json(await _client.GetAsync("/api/studio/scenes/round1"));
        Assert.Equal("Box", scene.GetProperty("objects")[0].GetProperty("name").GetString());
        Assert.True(scene.GetProperty("updatedAt").GetDateTimeOffset() > DateTimeOffset.UtcNow.AddMinutes(-5));
    }

    [Fact]
    public async Task A_scene_whose_body_names_another_id_is_refused_with_its_reason()
    {
        var put = await _client.PutAsJsonAsync("/api/studio/scenes/one", Scene("two"));

        Assert.Equal(HttpStatusCode.BadRequest, put.StatusCode);
        var problem = await Json(put);
        Assert.Equal("sceneInvalid", problem.GetProperty("reason").GetString());
        Assert.True(problem.GetProperty("errors").TryGetProperty("id", out _));
    }

    [Fact]
    public async Task A_scene_with_no_name_or_an_old_version_is_refused()
    {
        var put = await _client.PutAsJsonAsync("/api/studio/scenes/v1", new { version = 1, id = "v1", name = " ", objects = Array.Empty<object>() });

        Assert.Equal(HttpStatusCode.BadRequest, put.StatusCode);
        var errors = (await Json(put)).GetProperty("errors");
        Assert.True(errors.TryGetProperty("version", out _));
        Assert.True(errors.TryGetProperty("name", out _));
    }

    [Fact]
    public async Task An_unknown_scene_is_a_404_that_says_so()
    {
        var get = await _client.GetAsync("/api/studio/scenes/missing");

        Assert.Equal(HttpStatusCode.NotFound, get.StatusCode);
        Assert.Equal("sceneUnknown", (await Json(get)).GetProperty("reason").GetString());
    }

    [Fact]
    public async Task Deleting_a_scene_takes_it_out_of_the_list()
    {
        await _client.PutAsJsonAsync("/api/studio/scenes/gone", Scene("gone"));

        Assert.Equal(HttpStatusCode.NoContent, (await _client.DeleteAsync("/api/studio/scenes/gone")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await _client.DeleteAsync("/api/studio/scenes/gone")).StatusCode);
        var list = await Json(await _client.GetAsync("/api/studio/scenes"));
        Assert.DoesNotContain(list.EnumerateArray(), one => one.GetProperty("id").GetString() == "gone");
    }

    [Fact]
    public async Task An_uploaded_model_comes_back_by_its_key_cached_for_good()
    {
        var bytes = "solid cube\nendsolid cube\n"u8.ToArray();
        var post = await _client.PostAsync("/api/studio/models?ext=.stl", new ByteArrayContent(bytes));
        Assert.Equal(HttpStatusCode.OK, post.StatusCode);
        var key = (await Json(post)).GetProperty("key").GetString()!;
        Assert.EndsWith(".stl", key);

        var get = await _client.GetAsync($"/api/studio/models/{key}");
        Assert.Equal(HttpStatusCode.OK, get.StatusCode);
        Assert.Equal(bytes, await get.Content.ReadAsByteArrayAsync());
        Assert.Equal("model/stl", get.Content.Headers.ContentType?.MediaType);
        Assert.Equal(TimeSpan.FromDays(365), get.Headers.CacheControl?.MaxAge);
    }

    [Fact]
    public async Task A_model_of_a_kind_the_studio_does_not_keep_is_refused()
    {
        var post = await _client.PostAsync("/api/studio/models?ext=.exe", new ByteArrayContent([1, 2, 3]));

        Assert.Equal(HttpStatusCode.BadRequest, post.StatusCode);
        Assert.Equal("modelInvalid", (await Json(post)).GetProperty("reason").GetString());
    }

    [Fact]
    public async Task A_key_that_is_not_one_is_a_404()
    {
        var get = await _client.GetAsync("/api/studio/models/nothing.glb");

        Assert.Equal(HttpStatusCode.NotFound, get.StatusCode);
        Assert.Equal("modelUnknown", (await Json(get)).GetProperty("reason").GetString());
    }

    [Fact]
    public async Task Scenes_land_in_the_studio_folder_the_host_was_given()
    {
        await _client.PutAsJsonAsync("/api/studio/scenes/where", Scene("where"));

        Assert.True(File.Exists(Path.Combine(_factory.StudioPath, "scenes", "where.json")));
    }
}
```

- [ ] **Step 3: Run to see them fail**

Run: `cd /c/IT/mqtt-forge-studio && dotnet test tests/MqttForge.IntegrationTests -p:SkipFrontend=true --filter "FullyQualifiedName~StudioEndpointTests"`
Expected: FAIL — 404s for every route (no controller).

- [ ] **Step 4: Paths, registration, error mapping, static `.env`**

`src/MqttForge.Api/StorePaths.cs` — beside `FlowsFileName` add `public const string StudioDirectoryName = "studio";` and beside `Flows(...)`:

```csharp
    // A folder rather than a file: one JSON per scene and the model files they name.
    public static string Studio(IConfiguration config) =>
        config["MqttForge:StudioPath"] ?? Beside(config, StudioDirectoryName);
```

`src/MqttForge.Api/DependencyInjection.cs` — after `services.AddSingleton<FlowService>();` add:

```csharp
        // The 3D Studio's scenes and model files, side by side in one folder beside the settings.
        services.AddSingleton<IStudioSceneStore>(sp => new JsonStudioSceneStore(
            StorePaths.Studio(sp.GetRequiredService<IConfiguration>()),
            sp.GetRequiredService<ILogger<JsonStudioSceneStore>>()));
        services.AddSingleton<IStudioModelStore>(sp =>
            new FileStudioModelStore(StorePaths.Studio(sp.GetRequiredService<IConfiguration>())));
        services.AddSingleton<StudioService>();
```

(Add `using` lines only if the file does not already import `MqttForge.Domain.Abstractions`, `MqttForge.Infrastructure.Persistence` and `MqttForge.Application.Services` — check the top of the file.)

`src/MqttForge.Api/ErrorHandling/MqttExceptionHandler.cs` — in the status switch after the `FlowsNotSavedException` arm:

```csharp
            // The studio's twins of the flows' two arms, for the same two reasons.
            StudioSceneUnreadableException => (StatusCodes.Status409Conflict, "The scene file could not be read"),
            StudioNotSavedException => (StatusCodes.Status500InternalServerError, "Could not save the studio"),
```

and in the reason switch after `FlowsNotSavedException => "flowsNotSaved",`:

```csharp
            StudioSceneUnreadableException => "sceneUnreadable",
            StudioNotSavedException => "studioNotSaved",
```

`src/MqttForge.Api/MqttForgeHost.cs` — replace the `UseStaticFiles` line:

```csharp
        // The studio's lighting ships as a Babylon .env file, which the default table does not know
        // and would 404 — static files refuse what they cannot name rather than guess.
        var contentTypes = new FileExtensionContentTypeProvider();
        contentTypes.Mappings[".env"] = "application/octet-stream";
        app.UseStaticFiles(new StaticFileOptions { ContentTypeProvider = contentTypes, OnPrepareResponse = CacheByFilename });
```

- [ ] **Step 5: Validation rules**

```csharp
// src/MqttForge.Api/Validation/StudioSceneRules.cs
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

        if (!body.TryGetProperty("version", out var version) || !version.TryGetInt32(out var v) || v != Version)
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
                && (!model.TryGetProperty("key", out var key) || !StudioIds.IsModelKey(key.GetString())))
                Add($"objects[{index}].model", "A model has to name a file the studio stored.");

            index++;
        }

        return errors;
    }
}
```

- [ ] **Step 6: The controller**

```csharp
// src/MqttForge.Api/Controllers/StudioController.cs
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Net.Http.Headers;
using MqttForge.Api.Validation;
using MqttForge.Application.Services;
using MqttForge.Domain.Models;

namespace MqttForge.Api.Controllers;

[ApiController]
[Route("api/studio")]
public sealed class StudioController : ControllerBase
{
    // A scene is JSON with its models stored apart, so 8 MB is a very large scene; a model is the
    // CAD part itself, and a STEP file of a whole machine runs to a hundred megabytes and more.
    public const long SceneBodyBytes = 8 * 1024 * 1024;
    public const long ModelBodyBytes = 200L * 1024 * 1024;

    private static readonly Dictionary<string, string> ModelTypes = new(StringComparer.Ordinal)
    {
        [".glb"] = "model/gltf-binary",
        [".gltf"] = "model/gltf+json",
        [".stl"] = "model/stl",
        [".obj"] = "model/obj",
    };

    private readonly StudioService _studio;

    public StudioController(StudioService studio) => _studio = studio;

    [HttpGet("scenes")]
    public async Task<IActionResult> List(CancellationToken ct) => Ok(await _studio.ListAsync(ct));

    [HttpGet("scenes/{id}")]
    public async Task<IActionResult> Get(string id, CancellationToken ct)
    {
        var scene = StudioIds.IsSceneId(id) ? await _studio.GetAsync(id, ct) : null;

        return scene is { } found
            ? Content(found.GetRawText(), "application/json")
            : Problem404("No scene", $"There is no scene '{id}'.", "sceneUnknown");
    }

    [HttpPut("scenes/{id}")]
    [RequestSizeLimit(SceneBodyBytes)]
    public async Task<IActionResult> Put(string id, [FromBody] JsonElement scene, CancellationToken ct)
    {
        var errors = StudioIds.IsSceneId(id)
            ? StudioSceneRules.Check(id, scene)
            : new Dictionary<string, string[]> { ["id"] = ["A scene id is letters, digits, '-' and '_', up to 64."] };
        if (errors.Count > 0) return Refused("The scene was not saved", errors, "sceneInvalid");

        await _studio.SaveAsync(id, scene, DateTimeOffset.UtcNow, ct);
        return NoContent();
    }

    [HttpDelete("scenes/{id}")]
    public async Task<IActionResult> Delete(string id, CancellationToken ct) =>
        StudioIds.IsSceneId(id) && await _studio.DeleteAsync(id, ct)
            ? NoContent()
            : Problem404("No scene", $"There is no scene '{id}'.", "sceneUnknown");

    // The body is the file itself rather than a multipart form: one part per request is all the
    // studio sends, and a raw body streams straight to disk through the hash.
    [HttpPost("models")]
    [RequestSizeLimit(ModelBodyBytes)]
    public async Task<IActionResult> Upload([FromQuery] string? ext, CancellationToken ct)
    {
        var extension = ext?.ToLowerInvariant();
        if (!StudioIds.IsModelExtension(extension))
            return Refused("The model was not stored",
                new Dictionary<string, string[]> { ["ext"] = [$"'{ext}' is not a model format the studio keeps."] },
                "modelInvalid");

        var key = await _studio.PutModelAsync(Request.Body, extension!, ct);
        return Ok(new { key });
    }

    [HttpGet("models/{key}")]
    public IActionResult Model(string key)
    {
        var stream = _studio.OpenModel(key);
        if (stream is null) return Problem404("No model", $"There is no model '{key}'.", "modelUnknown");

        // The key is the content's hash, so what it names can never change: cached for good.
        Response.Headers.CacheControl = "public, max-age=31536000, immutable";
        var type = ModelTypes.GetValueOrDefault(Path.GetExtension(key), "application/octet-stream");
        return File(stream, type, lastModified: null, entityTag: new EntityTagHeaderValue($"\"{key}\""));
    }

    private static ObjectResult Refused(string title, Dictionary<string, string[]> errors, string reason)
    {
        var problem = new ValidationProblemDetails(errors) { Status = StatusCodes.Status400BadRequest, Title = title };
        problem.Extensions["reason"] = reason;

        return new ObjectResult(problem)
        {
            StatusCode = StatusCodes.Status400BadRequest,
            ContentTypes = { "application/problem+json" },
        };
    }

    private static ObjectResult Problem404(string title, string detail, string reason)
    {
        var problem = new ProblemDetails { Status = StatusCodes.Status404NotFound, Title = title, Detail = detail };
        problem.Extensions["reason"] = reason;

        return new ObjectResult(problem)
        {
            StatusCode = StatusCodes.Status404NotFound,
            ContentTypes = { "application/problem+json" },
        };
    }
}
```

- [ ] **Step 7: Run the integration tests**

Run: `cd /c/IT/mqtt-forge-studio && dotnet test tests/MqttForge.IntegrationTests -p:SkipFrontend=true --filter "FullyQualifiedName~StudioEndpointTests"`
Expected: PASS. If `ControllerDiscoveryTests` exists with a fixed list of controllers, run it too (`--filter "FullyQualifiedName~ControllerDiscoveryTests"`) and add `StudioController` where it enumerates them.

- [ ] **Step 8: Whole backend suites still green**

Run: `cd /c/IT/mqtt-forge-studio && dotnet test tests/MqttForge.UnitTests -p:SkipFrontend=true && dotnet test tests/MqttForge.IntegrationTests -p:SkipFrontend=true --filter "FullyQualifiedName!~StaticFileCachingTests"`
Expected: PASS (static-file tests need the built frontend and are run in Task 15).

- [ ] **Step 9: Commit**

```bash
cd /c/IT/mqtt-forge-studio
git add src/MqttForge.Api tests/MqttForge.IntegrationTests
git commit -m "feat: the api keeps studio scenes and model files under /api/studio, refusing a scene by its envelope rather than its 3d and serving each model under its hash with a cache that never has to ask again"
```

---

### Task 5: Babylon dependency and the pure helpers (units, expressions, angles, ids)

**Files:**
- Modify: `web/package.json` (via npm)
- Create: `web/src/features/studio/units/units.ts`, `units/units.test.ts`
- Create: `web/src/features/studio/units/evalExpr.ts`, `units/evalExpr.test.ts`
- Create: `web/src/features/studio/geometry/euler.ts`, `geometry/euler.test.ts`
- Create: `web/src/features/studio/geometry/snap.ts`, `geometry/snap.test.ts`
- Create: `web/src/features/studio/model/ids.ts`, `model/ids.test.ts`

**Interfaces:**
- Produces:
  - `type Vec3 = [number, number, number]; type Quat = [number, number, number, number]` (exported from `geometry/euler.ts`)
  - `type DisplayUnit = 'mm'|'cm'|'m'|'in'`; `DISPLAY_UNITS: Record<DisplayUnit, {factor:number; label:string; digits:number}>`; `toDisplay(m, unit)`, `fromDisplay(v, unit)`, `roundTo(v, digits)`, `formatLength(m, unit, digits?)`, `radToDeg`, `degToRad`, `formatAngle(rad)`
  - `evalExpr(text: string, opts?: { current?: number; length?: boolean; unit?: DisplayUnit }): number` (NaN when not understood)
  - `wrapAngle(a)`, `wrapEuler(e: Vec3): Vec3`, `nearestEuler(from: Vec3, to: Vec3): Vec3`, `quatFromEuler(e: Vec3): Quat`
  - `snapTo(value, step)`
  - `newId(): string` (16 lowercase hex chars)

- [ ] **Step 1: Add Babylon**

Run: `cd /c/IT/mqtt-forge-studio/web && npm install @babylonjs/core@9.36.0 @babylonjs/materials@9.36.0 --save-exact`
Expected: `package.json` gains both under `dependencies`; `package-lock.json` updated.

- [ ] **Step 2: Write the failing tests**

```ts
// web/src/features/studio/units/units.test.ts
import { describe, expect, it } from 'vitest';
import { formatAngle, formatLength, fromDisplay, roundTo, toDisplay } from './units';

describe('display units', () => {
  it('turns metres into the unit on show and back', () => {
    expect(toDisplay(0.0125, 'mm')).toBeCloseTo(12.5);
    expect(fromDisplay(12.5, 'mm')).toBeCloseTo(0.0125);
    expect(toDisplay(0.0254, 'in')).toBeCloseTo(1);
  });

  // DesignBox had three length formatters and two of them ignored the chosen unit, so the HUD
  // and the inspector disagreed about the same distance.
  it('writes a length in the chosen unit, without trailing zeros', () => {
    expect(formatLength(0.0125, 'mm')).toBe('12.5 mm');
    expect(formatLength(1.5, 'm')).toBe('1.5 m');
    expect(formatLength(0.0254, 'in')).toBe('1 in');
    expect(formatLength(0.123456, 'cm', 1)).toBe('12.3 cm');
  });

  it('rounds to a number of digits', () => {
    expect(roundTo(1.23456, 2)).toBe(1.23);
  });

  it('writes an angle in degrees', () => {
    expect(formatAngle(Math.PI / 2)).toBe('90°');
  });
});
```

```ts
// web/src/features/studio/units/evalExpr.test.ts
import { describe, expect, it } from 'vitest';
import { evalExpr } from './evalExpr';

describe('evalExpr', () => {
  it('works out arithmetic with precedence and brackets', () => {
    expect(evalExpr('1200/2')).toBe(600);
    expect(evalExpr('2*(30+15)')).toBe(90);
    expect(evalExpr('-3+5')).toBe(2);
  });

  it('reads a decimal comma as a point', () => {
    expect(evalExpr('0,5')).toBe(0.5);
  });

  it('applies a relative change to the current value', () => {
    expect(evalExpr('+50', { current: 10 })).toBe(60);
    expect(evalExpr('-=20', { current: 10 })).toBe(-10);
    expect(evalExpr('*=2', { current: 10 })).toBe(20);
    expect(evalExpr('/=4', { current: 10 })).toBe(2.5);
  });

  it('converts lengths with units into the display unit, in length fields only', () => {
    expect(evalExpr('10cm+2mm', { length: true, unit: 'mm' })).toBeCloseTo(102);
    expect(evalExpr('1in', { length: true, unit: 'mm' })).toBeCloseTo(25.4);
    expect(evalExpr('50mm', { length: false })).toBeNaN();
  });

  it('answers NaN for what it does not understand', () => {
    expect(evalExpr('')).toBeNaN();
    expect(evalExpr('2+')).toBeNaN();
    expect(evalExpr('abc')).toBeNaN();
    expect(evalExpr('1/0')).toBeNaN();
  });
});
```

```ts
// web/src/features/studio/geometry/euler.test.ts
import { Quaternion } from '@babylonjs/core';
import { describe, expect, it } from 'vitest';
import { nearestEuler, quatFromEuler, wrapAngle, wrapEuler } from './euler';

describe('angles', () => {
  it('wraps into (-π, π]', () => {
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapAngle(-Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapAngle((464 * Math.PI) / 180)).toBeCloseTo((104 * Math.PI) / 180);
    expect(wrapEuler([4 * Math.PI, 0, -3 * Math.PI])).toEqual([expect.closeTo(0), 0, expect.closeTo(Math.PI)]);
  });

  it('reaches the same pose by the shortest way on every axis', () => {
    const [x] = nearestEuler([(170 * Math.PI) / 180, 0, 0], [(-170 * Math.PI) / 180, 0, 0]);
    expect(x).toBeCloseTo((190 * Math.PI) / 180);
  });

  // Written by hand so the store stays free of Babylon; held to Babylon's own answer so a pose
  // typed into the inspector is the pose the gizmo then shows.
  it('builds the same quaternion Babylon does', () => {
    const e: [number, number, number] = [0.3, -1.1, 2.4];
    const ours = quatFromEuler(e);
    const theirs = Quaternion.FromEulerAngles(...e);
    expect(ours[0]).toBeCloseTo(theirs.x, 10);
    expect(ours[1]).toBeCloseTo(theirs.y, 10);
    expect(ours[2]).toBeCloseTo(theirs.z, 10);
    expect(ours[3]).toBeCloseTo(theirs.w, 10);
  });
});
```

```ts
// web/src/features/studio/geometry/snap.test.ts
import { describe, expect, it } from 'vitest';
import { snapTo } from './snap';

describe('snapTo', () => {
  it('rounds to the nearest step and leaves a value alone with no step', () => {
    expect(snapTo(0.0123, 0.01)).toBeCloseTo(0.01);
    expect(snapTo(0.0151, 0.01)).toBeCloseTo(0.02);
    expect(snapTo(0.0123, 0)).toBe(0.0123);
  });
});
```

```ts
// web/src/features/studio/model/ids.test.ts
import { describe, expect, it } from 'vitest';
import { newId } from './ids';

describe('newId', () => {
  it('is sixteen hex characters, a safe scene id, and does not repeat', () => {
    const ids = new Set(Array.from({ length: 1000 }, newId));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{16}$/);
  });
});
```

- [ ] **Step 3: Run to see them fail**

Run: `cd /c/IT/mqtt-forge-studio/web && npx vitest run src/features/studio`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement**

```ts
// web/src/features/studio/units/units.ts
/**
 * The scene is always metres; this is the one place a length becomes what the reader chose to read
 * it in. DesignBox had three formatters for this and two of them ignored the choice, so the HUD
 * and the inspector could disagree about one distance — there is one now, and everything uses it.
 */
export type DisplayUnit = 'mm' | 'cm' | 'm' | 'in';

export const DISPLAY_UNITS: Record<DisplayUnit, { factor: number; label: string; digits: number }> = {
  mm: { factor: 1000, label: 'mm', digits: 2 },
  cm: { factor: 100, label: 'cm', digits: 3 },
  m: { factor: 1, label: 'm', digits: 4 },
  in: { factor: 1 / 0.0254, label: 'in', digits: 3 },
};

export const toDisplay = (metres: number, unit: DisplayUnit) => metres * DISPLAY_UNITS[unit].factor;
export const fromDisplay = (value: number, unit: DisplayUnit) => value / DISPLAY_UNITS[unit].factor;

/** Rounded, and through Number so trailing zeros go: 1.50 is 1.5. */
export const roundTo = (value: number, digits: number) => Number(value.toFixed(digits));

export const formatLength = (metres: number, unit: DisplayUnit, digits = DISPLAY_UNITS[unit].digits) =>
  `${roundTo(toDisplay(metres, unit), digits)} ${DISPLAY_UNITS[unit].label}`;

export const radToDeg = (rad: number) => (rad * 180) / Math.PI;
export const degToRad = (deg: number) => (deg * Math.PI) / 180;

export const formatAngle = (rad: number, digits = 2) => `${roundTo(radToDeg(rad), digits)}°`;
```

```ts
// web/src/features/studio/units/evalExpr.ts
import { DISPLAY_UNITS, type DisplayUnit } from './units';

/** Metres per unit a reader may type after a number in a length field. */
const LENGTH_UNITS: Record<string, number> = { mm: 0.001, cm: 0.01, m: 1, in: 0.0254, '"': 0.0254 };

const TOKENS = /\d*\.?\d+(?:e[+-]?\d+)?\s*(?:mm|cm|in|m|")?|[-+*/()]|\S/gi;
const NUMBER = /^(\d*\.?\d+(?:e[+-]?\d+)?)\s*(mm|cm|in|m|")?$/i;
const RELATIVE = /^(\+=|-=|\*=|\/=|\+)/;

/**
 * Works out what a reader typed into a number field: arithmetic, a change relative to the value
 * already there ('+50', '-=20', '*=2'), and in length fields a unit after any number ('10cm+2mm'),
 * answered in the display unit. NaN for anything else — the field then goes back to what it held.
 *
 * A small recursive-descent parser rather than eval: the text comes from an input box.
 */
export function evalExpr(
  text: string,
  { current = 0, length = false, unit = 'm' }: { current?: number; length?: boolean; unit?: DisplayUnit } = {},
): number {
  let source = text.trim().replace(/,/g, '.').replace(/°/g, '');
  if (!source) return Number.NaN;

  let relative: string | null = null;
  const prefix = source.match(RELATIVE);
  if (prefix) {
    relative = prefix[1] === '+' ? '+=' : prefix[1];
    source = source.slice(prefix[1].length);
  }

  const tokens = source.match(TOKENS) ?? [];
  let at = 0;
  const peek = () => tokens[at];

  const factor = (): number => {
    const token = tokens[at++];
    if (token === '(') {
      const inner = sum();
      return tokens[at++] === ')' ? inner : Number.NaN;
    }
    if (token === '-') return -factor();
    if (token === '+') return factor();

    const match = token?.match(NUMBER);
    if (!match) return Number.NaN;

    const value = Number.parseFloat(match[1]);
    if (!match[2]) return value;
    if (!length) return Number.NaN;
    return value * LENGTH_UNITS[match[2].toLowerCase()] * DISPLAY_UNITS[unit].factor;
  };

  const product = (): number => {
    let value = factor();
    while (peek() === '*' || peek() === '/') value = tokens[at++] === '*' ? value * factor() : value / factor();
    return value;
  };

  const sum = (): number => {
    let value = product();
    while (peek() === '+' || peek() === '-') value = tokens[at++] === '+' ? value + product() : value - product();
    return value;
  };

  let value = sum();
  if (at !== tokens.length || !Number.isFinite(value)) return Number.NaN;

  if (relative === '+=') value = current + value;
  else if (relative === '-=') value = current - value;
  else if (relative === '*=') value = current * value;
  else if (relative === '/=') value = current / value;

  return Number.isFinite(value) ? value : Number.NaN;
}
```

```ts
// web/src/features/studio/geometry/euler.ts
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

const TAU = 2 * Math.PI;

/**
 * Into (-π, π]. A gimbal ring turned round and round used to leave 464° in the panel — the same
 * pose, but a nonsense number, and typing a new angle then went the long way round.
 */
export const wrapAngle = (a: number) => {
  const wrapped = a - TAU * Math.round(a / TAU);
  return wrapped <= -Math.PI + 1e-9 ? wrapped + TAU : wrapped;
};

export const wrapEuler = ([x, y, z]: Vec3): Vec3 => [wrapAngle(x), wrapAngle(y), wrapAngle(z)];

/** The angles that reach `to`'s pose from `from` the shortest way on each axis. */
export const nearestEuler = (from: Vec3, to: Vec3): Vec3 => [
  from[0] + wrapAngle(to[0] - from[0]),
  from[1] + wrapAngle(to[1] - from[1]),
  from[2] + wrapAngle(to[2] - from[2]),
];

/**
 * Babylon's `Quaternion.FromEulerAngles(x, y, z)` — yaw y, pitch x, roll z — written out so the
 * store can turn an angle typed into the inspector into a rotation without importing Babylon.
 */
export function quatFromEuler([x, y, z]: Vec3): Quat {
  const [sr, cr] = [Math.sin(z / 2), Math.cos(z / 2)];
  const [sp, cp] = [Math.sin(x / 2), Math.cos(x / 2)];
  const [sy, cy] = [Math.sin(y / 2), Math.cos(y / 2)];

  return [
    cy * sp * cr + sy * cp * sr,
    sy * cp * cr - cy * sp * sr,
    cy * cp * sr - sy * sp * cr,
    cy * cp * cr + sy * sp * sr,
  ];
}
```

```ts
// web/src/features/studio/geometry/snap.ts
/** To the nearest multiple of `step`; a step of zero or less means no snapping. */
export const snapTo = (value: number, step: number) => (step > 0 ? Math.round(value / step) * step : value);
```

```ts
// web/src/features/studio/model/ids.ts
/**
 * The studio's one id generator — DesignBox had six, each its own shape of random.
 *
 * getRandomValues rather than randomUUID: the console is opened over plain http on the LAN (the QR
 * panel's whole point), which is not a secure context, and randomUUID is not there. Sixteen hex
 * characters also pass the server's scene-id rule as they are.
 */
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
```

- [ ] **Step 5: Run the tests**

Run: `cd /c/IT/mqtt-forge-studio/web && npx vitest run src/features/studio`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /c/IT/mqtt-forge-studio
git add web/package.json web/package-lock.json web/src/features/studio
git commit -m "feat: the studio's arithmetic comes over from designbox as tested modules — one length formatter that honours the chosen unit, the expression parser, angle wrapping and a quaternion held to babylon's own — with babylon itself from npm so nothing is fetched at run time"
```

---

### Task 6: Scene document and the DesignBox file reader

**Files:**
- Create: `web/src/features/studio/model/document.ts`
- Create: `web/src/features/studio/model/defaults.ts`
- Create: `web/src/features/studio/model/dataUrl.ts`, `model/dataUrl.test.ts`
- Create: `web/src/features/studio/model/sceneFile.ts`, `model/sceneFile.test.ts`
- Create: `web/src/features/studio/model/fixtures/designbox-v1.json`

**Interfaces:**
- Consumes: `Vec3`, `Quat`, `quatFromEuler` (Task 5), `DisplayUnit` (Task 5), `newId` (Task 5)
- Produces:
  - Types: `PrimitiveType`, `ObjectType`, `Material`, `MaterialOverride`, `ModelRef`, `Joint`, `Group`, `Pose`, `Annotation`, `SceneSettings`, `StudioObject`, `StudioScene` (exact shapes below), `SCENE_VERSION = 2`
  - `PRIMITIVE_TYPES: readonly PrimitiveType[]`, `PRIMITIVE_LABELS: Record<PrimitiveType, string>`, `PRIMITIVE_COLOURS` (palette), `restHeight(type: ObjectType): number`, `DEFAULT_SETTINGS`, `MATERIAL_PRESETS: Record<MaterialPreset, {label, metal, rough}>`, `type MaterialPreset`, `blankScene(name: string): StudioScene`, `newPrimitive(type, index, at: Vec3, name: string): StudioObject`
  - `dataUrlToBlob(url: string): { blob: Blob; mime: string }`
  - `class SceneFileError extends Error`
  - `readSceneFile(raw: unknown, fallback: { id: string; name: string }): { scene: StudioScene; pending: PendingModel[] }`
  - `type PendingModel = { objectId: string; dataUrl: string; ext: string }`
  - `uploadPending(scene: StudioScene, pending: PendingModel[], upload: (blob: Blob, ext: string) => Promise<{ key: string }>): Promise<StudioScene>`

- [ ] **Step 1: The fixture** — a DesignBox v1 file trimmed to what the reader must handle: a primitive, a linked primitive, an inline STL model, an unnamed joint with no type, a group, a pose and an annotation.

```json
{
  "version": 1,
  "objects": [
    { "type": "box", "name": "Base", "pid": "p-base", "position": [0, 0.5, 0], "rotation": [0, 0, 0, 1], "euler": [0, 0, 0], "scaling": [2, 1, 2], "color": "#4f9cff", "mat": { "metal": 1, "rough": 0.35 } },
    { "type": "cylinder", "name": "Arm", "pid": "p-arm", "position": [0, 1.5, 0], "rotation": [0, 0, 0, 1], "euler": [0, 0, 0], "scaling": [0.2, 1, 0.2], "color": "#ff6b6b", "link": 0, "joint": { "pivot": [0, -0.5, 0], "axis": [0, 1, 0], "zero": [0, 0, 0, 1], "min": -90, "max": 90 }, "groupId": "g1" },
    { "type": "model", "name": "Bracket", "pid": "p-model", "position": [1, 0, 1], "rotation": [0, 0, 0, 1], "euler": [0, 0, 0], "scaling": [1, 1, 1], "model": "data:model/stl;base64,c29saWQgYnJhY2tldAplbmRzb2xpZCBicmFja2V0Cg==", "modelKey": "idb-123", "ext": ".stl", "pivot": "center", "importScale": 0.001 }
  ],
  "groups": [{ "id": "g1", "name": "Arm group", "collapsed": false }],
  "poses": [{ "id": "pose1", "name": "Up", "angles": { "p-arm": 45 } }],
  "annotations": [{ "id": "a1", "type": "gap", "A": "p-base", "B": "p-arm" }]
}
```

Save it as `web/src/features/studio/model/fixtures/designbox-v1.json`.

- [ ] **Step 2: Write the failing tests**

```ts
// web/src/features/studio/model/dataUrl.test.ts
import { describe, expect, it } from 'vitest';
import { dataUrlToBlob } from './dataUrl';

describe('dataUrlToBlob', () => {
  it('decodes a base64 data url into its bytes and type', async () => {
    const { blob, mime } = dataUrlToBlob('data:model/stl;base64,c29saWQ=');
    expect(mime).toBe('model/stl');
    expect(await blob.text()).toBe('solid');
  });

  it('refuses anything that is not a base64 data url', () => {
    expect(() => dataUrlToBlob('https://example.com/a.stl')).toThrow();
  });
});
```

```ts
// web/src/features/studio/model/sceneFile.test.ts
import { describe, expect, it, vi } from 'vitest';
import designbox from './fixtures/designbox-v1.json';
import { blankScene } from './defaults';
import { readSceneFile, SceneFileError, uploadPending } from './sceneFile';

const fallback = { id: 'new1', name: 'Imported' };

describe('reading a DesignBox scene', () => {
  const { scene, pending } = readSceneFile(designbox, fallback);

  it('becomes a version 2 scene under the id and name it is given', () => {
    expect(scene.version).toBe(2);
    expect(scene.id).toBe('new1');
    expect(scene.name).toBe('Imported');
    expect(scene.objects).toHaveLength(3);
  });

  it('keeps each object\'s persistent id, so poses and annotations still point at it', () => {
    expect(scene.objects.map((o) => o.id)).toEqual(['p-base', 'p-arm', 'p-model']);
    expect(scene.poses[0].angles).toEqual({ 'p-arm': 45 });
    expect(scene.annotations[0]).toMatchObject({ A: 'p-base', B: 'p-arm' });
  });

  // DesignBox linked by position in the list, which any reorder silently rewired.
  it('turns a link by index into a parent by id', () => {
    expect(scene.objects[1].parentId).toBe('p-base');
  });

  it('names an unnamed joint and makes a typeless one revolute', () => {
    expect(scene.objects[1].joint).toMatchObject({ type: 'rev', name: 'Joint 1', min: -90, max: 90 });
  });

  it('keeps transform, colour, material and group', () => {
    expect(scene.objects[0]).toMatchObject({ position: [0, 0.5, 0], scaling: [2, 1, 2], color: '#4f9cff', mat: { metal: 1, rough: 0.35 } });
    expect(scene.objects[1].groupId).toBe('g1');
    expect(scene.groups[0]).toMatchObject({ id: 'g1', name: 'Arm group' });
  });

  it('takes the inline model out to be uploaded, keeping what Phase 2 needs to draw it', () => {
    expect(pending).toEqual([{ objectId: 'p-model', dataUrl: expect.stringMatching(/^data:model\/stl;base64,/), ext: '.stl' }]);
    expect(scene.objects[2].model).toEqual({ key: '', ext: '.stl', importScale: 0.001 });
    expect(scene.objects[2].legacy).toEqual({ pivot: 'center' });
  });

  it('reads a file with no version as version 1', () => {
    const { scene: unversioned } = readSceneFile({ ...designbox, version: undefined }, fallback);
    expect(unversioned.objects).toHaveLength(3);
  });
});

describe('reading a version 2 scene', () => {
  it('answers it as it is, with nothing to upload', () => {
    const saved = blankScene('Cell');
    const { scene, pending } = readSceneFile(JSON.parse(JSON.stringify(saved)), fallback);
    expect(scene).toEqual(saved);
    expect(pending).toEqual([]);
  });
});

describe('a file that is not a scene', () => {
  it('says what is wrong with it', () => {
    expect(() => readSceneFile('hello', fallback)).toThrow(SceneFileError);
    expect(() => readSceneFile({ version: 3, objects: [] }, fallback)).toThrow(/newer/);
    expect(() => readSceneFile({ version: 1 }, fallback)).toThrow(/objects/);
  });
});

describe('uploadPending', () => {
  it('uploads each inline model and writes its key into the object', async () => {
    const { scene, pending } = readSceneFile(designbox, fallback);
    const upload = vi.fn().mockResolvedValue({ key: 'a'.repeat(64) + '.stl' });

    const done = await uploadPending(scene, pending, upload);

    expect(upload).toHaveBeenCalledWith(expect.any(Blob), '.stl');
    expect(done.objects[2].model?.key).toBe('a'.repeat(64) + '.stl');
    expect(scene.objects[2].model?.key).toBe('');
  });
});
```

- [ ] **Step 3: Run to see them fail**

Run: `cd /c/IT/mqtt-forge-studio/web && npx vitest run src/features/studio/model`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement**

```ts
// web/src/features/studio/model/document.ts
import type { Quat, Vec3 } from '../geometry/euler';
import type { DisplayUnit } from '../units/units';

/**
 * The scene as it is saved — DesignBox's sahne.json made explicit and versioned.
 *
 * Version 1 is what DesignBox wrote (and never checked on reading). Version 2 is this: object ids
 * instead of list positions for links, model files referenced by key instead of carried inline as
 * base64, and settings that used to live in the browser's own storage.
 *
 * Joints, groups, poses and annotations are typed loosely on purpose. Phase 1 neither draws nor
 * edits them; it only has to carry them through a save untouched, and Phase 3 narrows the types
 * when it starts using them.
 */
export const SCENE_VERSION = 2;

export type PrimitiveType = 'box' | 'sphere' | 'cylinder' | 'cone' | 'pyramid' | 'torus' | 'capsule' | 'wall';
export type ObjectType = PrimitiveType | 'model';

export type Material = { metal: number; rough: number };
export type MaterialOverride = Material & { color: string };
export type ModelRef = { key: string; ext: string; importScale?: number };

export type Joint = { type: 'rev' | 'lin'; name: string } & Record<string, unknown>;
export type Group = { id: string; name: string } & Record<string, unknown>;
export type Pose = { id: string; name: string; angles: Record<string, number> };
export type Annotation = { id: string; type: string } & Record<string, unknown>;

export type SceneSettings = {
  displayUnit: DisplayUnit;
  /** Metres. */
  moveStep: number;
  /** Degrees. */
  rotateStep: number;
  snap: boolean;
};

export type StudioObject = {
  id: string;
  type: ObjectType;
  name: string;
  position: Vec3;
  rotation: Quat;
  /** Radians, kept beside the quaternion so the inspector shows the angles the reader typed. */
  euler: Vec3;
  scaling: Vec3;
  color?: string;
  mat?: Material;
  matOverride?: MaterialOverride;
  model?: ModelRef;
  parentId?: string;
  groupId?: string;
  groupUnlocked?: boolean;
  hidden?: boolean;
  frozen?: boolean;
  transparent?: boolean;
  rotPivot?: Vec3;
  joint?: Joint;
  /** Fields a DesignBox file carried that this version does not act on yet, kept for a later phase. */
  legacy?: Record<string, unknown>;
};

export type StudioScene = {
  version: typeof SCENE_VERSION;
  id: string;
  name: string;
  updatedAt: string;
  settings: SceneSettings;
  objects: StudioObject[];
  groups: Group[];
  poses: Pose[];
  annotations: Annotation[];
};
```

```ts
// web/src/features/studio/model/defaults.ts
import type { Vec3 } from '../geometry/euler';
import { newId } from './ids';
import { SCENE_VERSION, type ObjectType, type PrimitiveType, type SceneSettings, type StudioObject, type StudioScene } from './document';

export const PRIMITIVE_TYPES: readonly PrimitiveType[] = ['box', 'sphere', 'cylinder', 'cone', 'pyramid', 'torus', 'capsule', 'wall'];

export const PRIMITIVE_LABELS: Record<PrimitiveType, string> = {
  box: 'Box',
  sphere: 'Sphere',
  cylinder: 'Cylinder',
  cone: 'Cone',
  pyramid: 'Pyramid',
  torus: 'Torus',
  capsule: 'Capsule',
  wall: 'Wall',
};

/** Handed out in turn, so a row of new shapes can be told apart before anyone colours them. */
export const PRIMITIVE_COLOURS = ['#4f9cff', '#ff6b6b', '#ffd43b', '#69db7c', '#b197fc', '#ff922b', '#3bc9db', '#f783ac'];
const WALL_COLOUR = '#d9d4cc';

/**
 * How far above its origin each shape's base sits at scale 1, so a new one lands on the ground
 * rather than half in it. Matches the sizes `engine/primitives.ts` builds.
 */
const REST_HEIGHT: Record<ObjectType, number> = {
  box: 0.5, sphere: 0.5, cylinder: 0.5, cone: 0.5, pyramid: 0.5, torus: 0.15, capsule: 0.6, wall: 0.75, model: 0.25,
};
export const restHeight = (type: ObjectType) => REST_HEIGHT[type];

export const MATERIAL_PRESETS = {
  plastic: { label: 'Plastic', metal: 0, rough: 0.5 },
  matte: { label: 'Matte', metal: 0, rough: 0.9 },
  glossy: { label: 'Gloss paint', metal: 0, rough: 0.15 },
  steel: { label: 'Steel', metal: 1, rough: 0.35 },
  brushed: { label: 'Brushed metal', metal: 1, rough: 0.55 },
  chrome: { label: 'Chrome', metal: 1, rough: 0.05 },
} as const;
export type MaterialPreset = keyof typeof MATERIAL_PRESETS;
export const DEFAULT_MATERIAL = { metal: 0, rough: 0.5 };

export const DEFAULT_SETTINGS: SceneSettings = { displayUnit: 'mm', moveStep: 0.01, rotateStep: 15, snap: true };

export function blankScene(name: string): StudioScene {
  return {
    version: SCENE_VERSION,
    id: newId(),
    name,
    updatedAt: new Date().toISOString(),
    settings: { ...DEFAULT_SETTINGS },
    objects: [],
    groups: [],
    poses: [],
    annotations: [],
  };
}

/** A new shape standing on the ground at `at`; `index` picks its colour from the palette. */
export function newPrimitive(type: PrimitiveType, index: number, at: Vec3, name: string): StudioObject {
  return {
    id: newId(),
    type,
    name,
    position: [at[0], at[1] + restHeight(type), at[2]],
    rotation: [0, 0, 0, 1],
    euler: [0, 0, 0],
    scaling: [1, 1, 1],
    color: type === 'wall' ? WALL_COLOUR : PRIMITIVE_COLOURS[index % PRIMITIVE_COLOURS.length],
  };
}
```

```ts
// web/src/features/studio/model/dataUrl.ts
const DATA_URL = /^data:([^;,]+)?;base64,(.*)$/s;

/**
 * A DesignBox model carried inline as a base64 data url, as bytes again. Decoded by hand rather
 * than through fetch(), which would put a file of tens of megabytes through the network layer to
 * get it back out.
 */
export function dataUrlToBlob(url: string): { blob: Blob; mime: string } {
  const match = url.match(DATA_URL);
  if (!match) throw new Error('Not a base64 data url.');

  const mime = match[1] ?? 'application/octet-stream';
  const text = atob(match[2]);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);

  return { blob: new Blob([bytes], { type: mime }), mime };
}
```

```ts
// web/src/features/studio/model/sceneFile.ts
import { quatFromEuler, type Quat, type Vec3 } from '../geometry/euler';
import { dataUrlToBlob } from './dataUrl';
import { DEFAULT_SETTINGS } from './defaults';
import { SCENE_VERSION, type Annotation, type Group, type Joint, type ObjectType, type Pose, type StudioObject, type StudioScene } from './document';

/** Why a file could not be read as a scene, in a sentence the reader is shown. */
export class SceneFileError extends Error {}

/** An inline DesignBox model waiting to be uploaded before its scene is saved. */
export type PendingModel = { objectId: string; dataUrl: string; ext: string };

type Raw = Record<string, unknown>;
const isObject = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const vec3 = (value: unknown, fallback: Vec3): Vec3 =>
  Array.isArray(value) && value.length === 3 && value.every(Number.isFinite) ? (value as Vec3) : fallback;
const quat = (value: unknown, fallback: Quat): Quat =>
  Array.isArray(value) && value.length === 4 && value.every(Number.isFinite) ? (value as Quat) : fallback;

/** The fields a version 1 object carries that this reader turns into something else, or drops. */
const CONSUMED = new Set([
  'type', 'name', 'pid', 'position', 'rotation', 'euler', 'scaling', 'color', 'mat', 'matOverride', 'model', 'modelKey',
  'ext', 'importScale', 'link', 'groupId', 'groupUnlocked', 'hidden', 'frozen', 'transparent', 'rotPivot', 'joint', 'uid',
]);

/**
 * A scene file as the studio can use it: version 2 as it is, version 1 (DesignBox's sahne.json, or
 * an export with no version at all) migrated, and anything newer refused rather than half read.
 *
 * `fallback` is the id and name a version 1 file is given: DesignBox scenes had neither inside the
 * file. Inline models come back in `pending`, to be uploaded by `uploadPending` before the scene is
 * saved — the scene keeps an empty key for them until then.
 */
export function readSceneFile(raw: unknown, fallback: { id: string; name: string }): { scene: StudioScene; pending: PendingModel[] } {
  if (!isObject(raw)) throw new SceneFileError('This file is not a scene: it holds no JSON object.');

  const version = raw.version ?? 1;
  if (version === SCENE_VERSION) return { scene: raw as StudioScene, pending: [] };
  if (typeof version !== 'number' || version > SCENE_VERSION)
    throw new SceneFileError('This scene was written by a newer version of the studio and cannot be opened here.');
  if (!Array.isArray(raw.objects)) throw new SceneFileError('This file is not a scene: it has no list of objects.');

  return fromVersion1(raw, raw.objects, fallback);
}

function fromVersion1(raw: Raw, items: unknown[], fallback: { id: string; name: string }) {
  const sources = items.filter(isObject);
  // Ids first, so a link can be resolved whichever way round the two objects are listed.
  const ids = sources.map((item, i) => (typeof item.pid === 'string' && item.pid ? item.pid : `obj-${i + 1}`));
  const pending: PendingModel[] = [];
  let unnamedJoints = 0;

  const objects = sources.map((item, i): StudioObject => {
    const euler = vec3(item.euler, [0, 0, 0]);
    const object: StudioObject = {
      id: ids[i],
      type: (typeof item.type === 'string' ? item.type : 'box') as ObjectType,
      name: typeof item.name === 'string' ? item.name : `Object ${i + 1}`,
      position: vec3(item.position, [0, 0, 0]),
      rotation: quat(item.rotation, quatFromEuler(euler)),
      euler,
      scaling: vec3(item.scaling, [1, 1, 1]),
    };

    if (typeof item.color === 'string') object.color = item.color;
    if (isObject(item.mat)) object.mat = item.mat as StudioObject['mat'];
    if (isObject(item.matOverride)) object.matOverride = item.matOverride as StudioObject['matOverride'];
    if (typeof item.groupId === 'string') object.groupId = item.groupId;
    if (item.groupUnlocked === true) object.groupUnlocked = true;
    if (item.hidden === true) object.hidden = true;
    if (item.frozen === true) object.frozen = true;
    if (item.transparent === true) object.transparent = true;
    if (Array.isArray(item.rotPivot)) object.rotPivot = vec3(item.rotPivot, [0, 0, 0]);

    // DesignBox linked by position in the list; a link to itself or past the end is no link.
    if (typeof item.link === 'number' && item.link !== i && ids[item.link] !== undefined) object.parentId = ids[item.link];

    if (isObject(item.joint)) {
      const joint = { ...item.joint } as Joint;
      if (joint.type !== 'lin') joint.type = 'rev';
      if (typeof joint.name !== 'string' || !joint.name.trim()) joint.name = `Joint ${++unnamedJoints}`;
      object.joint = joint;
    }

    if (object.type === 'model') {
      const ext = typeof item.ext === 'string' ? item.ext.toLowerCase() : '';
      object.model = { key: '', ext, ...(typeof item.importScale === 'number' ? { importScale: item.importScale } : {}) };
      if (typeof item.model === 'string' && item.model.startsWith('data:')) pending.push({ objectId: object.id, dataUrl: item.model, ext });
    }

    const legacy = Object.fromEntries(Object.entries(item).filter(([key]) => !CONSUMED.has(key)));
    if (Object.keys(legacy).length > 0) object.legacy = legacy;

    return object;
  });

  const scene: StudioScene = {
    version: SCENE_VERSION,
    id: fallback.id,
    name: fallback.name,
    updatedAt: new Date().toISOString(),
    settings: { ...DEFAULT_SETTINGS },
    objects,
    groups: (Array.isArray(raw.groups) ? raw.groups.filter(isObject) : []) as Group[],
    poses: (Array.isArray(raw.poses) ? raw.poses.filter(isObject) : []) as Pose[],
    annotations: (Array.isArray(raw.annotations) ? raw.annotations.filter(isObject) : []) as Annotation[],
  };

  return { scene, pending };
}

/** Uploads each pending model and answers the scene with their keys in place; the input is not changed. */
export async function uploadPending(
  scene: StudioScene,
  pending: PendingModel[],
  upload: (blob: Blob, ext: string) => Promise<{ key: string }>,
): Promise<StudioScene> {
  const keys = new Map<string, string>();
  for (const model of pending) {
    const { key } = await upload(dataUrlToBlob(model.dataUrl).blob, model.ext);
    keys.set(model.objectId, key);
  }

  return {
    ...scene,
    objects: scene.objects.map((object) =>
      object.model && keys.has(object.id) ? { ...object, model: { ...object.model, key: keys.get(object.id)! } } : object,
    ),
  };
}
```

Note: `tsconfig` must allow JSON imports for the fixture. Check `web/tsconfig.app.json` for `"resolveJsonModule": true`; if absent, add it under `compilerOptions`.

- [ ] **Step 5: Run the tests**

Run: `cd /c/IT/mqtt-forge-studio/web && npx vitest run src/features/studio/model`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /c/IT/mqtt-forge-studio
git add web/src/features/studio/model web/tsconfig.app.json
git commit -m "feat: the studio's scene document is typed and versioned, and a designbox sahne.json reads into it with links by id rather than list position, joints named and typed, and inline models held out for upload instead of riding along as base64"
```

---

### Task 7: The store and its history

**Files:**
- Create: `web/src/features/studio/history.ts`, `history.test.ts`
- Create: `web/src/features/studio/studioStore.ts`, `studioStore.test.ts`

**Interfaces:**
- Consumes: Task 5 (`Vec3`, `quatFromEuler`, `wrapEuler`), Task 6 (document types, `newPrimitive`, `PRIMITIVE_LABELS`)
- Produces:
  - `history.ts`: `HISTORY_LIMIT = 100`; `type History = { past: StudioScene[]; future: StudioScene[] }`; `record(h, before): History`; `undo(h, current): { history, scene } | null`; `redo(h, current): { history, scene } | null`
  - `studioStore.ts`:
    - `type Tool = 'select' | 'move' | 'rotate' | 'scale'`; `type Orientation = 'world' | 'local'`
    - `type StudioState` (fields: `scene: StudioScene | null`, `selection: string[]`, `tool: Tool`, `orientation: Orientation`, `clipboard: StudioObject[]`, `history: History`, `gestureBase: StudioScene | null`, `revision: number`, `savedRevision: number`; actions below)
    - actions: `open(scene, saved?: boolean)`, `close()`, `addPrimitive(type, at: Vec3): string`, `updateObject(id, patch: Partial<StudioObject>)`, `setEuler(id, euler: Vec3)`, `rename(id, name)`, `removeObjects(ids)`, `duplicate(ids): string[]`, `copy(ids)`, `paste(): string[]`, `select(ids)`, `setTool(tool)`, `setOrientation(o)`, `updateSettings(patch)`, `renameScene(name)`, `beginGesture()`, `endGesture()`, `undo()`, `redo()`, `markSaved(revision)`
    - `createStudioStore(): StoreApi<StudioState>`; `studioStore` (the app's one); `useStudio<T>(selector: (s: StudioState) => T): T`; `isDirty(s): boolean`

- [ ] **Step 1: Write the failing tests**

```ts
// web/src/features/studio/history.test.ts
import { describe, expect, it } from 'vitest';
import { blankScene } from './model/defaults';
import { HISTORY_LIMIT, record, redo, undo } from './history';

describe('history', () => {
  it('steps back to what was recorded and forward again', () => {
    const a = blankScene('A');
    const b = { ...a, name: 'B' };
    const h = record({ past: [], future: [] }, a);

    const back = undo(h, b)!;
    expect(back.scene).toBe(a);
    const forward = redo(back.history, back.scene)!;
    expect(forward.scene).toBe(b);
  });

  it('has nothing to undo or redo when empty', () => {
    expect(undo({ past: [], future: [] }, blankScene('A'))).toBeNull();
    expect(redo({ past: [], future: [] }, blankScene('A'))).toBeNull();
  });

  it('forgets the redo trail once something new is recorded', () => {
    const a = blankScene('A');
    const back = undo(record({ past: [], future: [] }, a), { ...a, name: 'B' })!;
    expect(record(back.history, a).future).toEqual([]);
  });

  it('keeps no more than its limit', () => {
    let h = { past: [], future: [] } as ReturnType<typeof record>;
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) h = record(h, blankScene(String(i)));
    expect(h.past).toHaveLength(HISTORY_LIMIT);
    expect(h.past[0].name).toBe('10');
  });
});
```

```ts
// web/src/features/studio/studioStore.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import type { StoreApi } from 'zustand';
import { blankScene } from './model/defaults';
import { createStudioStore, isDirty, type StudioState } from './studioStore';

let store: StoreApi<StudioState>;
const s = () => store.getState();

beforeEach(() => {
  store = createStudioStore();
  s().open(blankScene('Cell'));
});

describe('studio store', () => {
  it('adds a primitive standing on the ground, named, coloured and selected', () => {
    const id = s().addPrimitive('box', [1, 0, 2]);
    const box = s().scene!.objects[0];
    expect(box).toMatchObject({ id, type: 'box', name: 'Box 1', position: [1, 0.5, 2] });
    expect(box.color).toMatch(/^#/);
    expect(s().selection).toEqual([id]);
  });

  it('numbers names per kind so a second box is not called the same', () => {
    s().addPrimitive('box', [0, 0, 0]);
    s().addPrimitive('box', [0, 0, 0]);
    expect(s().scene!.objects.map((o) => o.name)).toEqual(['Box 1', 'Box 2']);
  });

  it('makes each discrete change one undo step, and redo puts it back', () => {
    const id = s().addPrimitive('box', [0, 0, 0]);
    s().updateObject(id, { color: '#000000' });
    s().undo();
    expect(s().scene!.objects[0].color).not.toBe('#000000');
    s().undo();
    expect(s().scene!.objects).toHaveLength(0);
    s().redo();
    s().redo();
    expect(s().scene!.objects[0].color).toBe('#000000');
  });

  // A gizmo drag sends a change on every pointer move; DesignBox turned whichever of those landed
  // after its 300 ms save debounce into undo steps. A gesture is one step, however many moves.
  it('makes a whole gesture one undo step', () => {
    const id = s().addPrimitive('box', [0, 0, 0]);
    s().beginGesture();
    for (let x = 1; x <= 20; x++) s().updateObject(id, { position: [x, 0.5, 0] });
    s().endGesture();
    expect(s().scene!.objects[0].position).toEqual([20, 0.5, 0]);
    s().undo();
    expect(s().scene!.objects[0].position).toEqual([0, 0.5, 0]);
  });

  it('records nothing for a gesture that changed nothing', () => {
    s().addPrimitive('box', [0, 0, 0]);
    const before = s().history.past.length;
    s().beginGesture();
    s().endGesture();
    expect(s().history.past).toHaveLength(before);
  });

  it('sets angles and the matching rotation together, wrapped', () => {
    const id = s().addPrimitive('box', [0, 0, 0]);
    s().setEuler(id, [0, 3 * Math.PI, 0]);
    const box = s().scene!.objects[0];
    expect(box.euler[1]).toBeCloseTo(Math.PI);
    expect(box.rotation[1]).toBeCloseTo(1);
  });

  it('duplicates beside the original and selects the copy', () => {
    const id = s().addPrimitive('box', [0, 0, 0]);
    const [copy] = s().duplicate([id]);
    expect(copy).not.toBe(id);
    expect(s().scene!.objects[1]).toMatchObject({ name: 'Box 1 copy', position: [0.5, 0.5, 0.5] });
    expect(s().selection).toEqual([copy]);
  });

  it('pastes what was copied as new objects', () => {
    const id = s().addPrimitive('sphere', [0, 0, 0]);
    s().copy([id]);
    const pasted = s().paste();
    expect(pasted).toHaveLength(1);
    expect(s().scene!.objects).toHaveLength(2);
  });

  it('removes objects and drops them from the selection', () => {
    const id = s().addPrimitive('box', [0, 0, 0]);
    s().removeObjects([id]);
    expect(s().scene!.objects).toHaveLength(0);
    expect(s().selection).toEqual([]);
  });

  it('is dirty after a change and clean once that revision is saved', () => {
    expect(isDirty(s())).toBe(false);
    s().addPrimitive('box', [0, 0, 0]);
    expect(isDirty(s())).toBe(true);
    s().markSaved(s().revision);
    expect(isDirty(s())).toBe(false);
  });

  it('opens an unsaved scene as dirty, so a new one is written straight away', () => {
    s().open(blankScene('New'), false);
    expect(isDirty(s())).toBe(true);
  });

  it('starts every opened scene with no history and no selection', () => {
    s().addPrimitive('box', [0, 0, 0]);
    s().open(blankScene('Other'));
    expect(s().history.past).toEqual([]);
    expect(s().selection).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `cd /c/IT/mqtt-forge-studio/web && npx vitest run src/features/studio/history.test.ts src/features/studio/studioStore.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```ts
// web/src/features/studio/history.ts
import type { StudioScene } from './model/document';

/** Steps kept. Snapshots share every object a change did not touch, so a step costs what it changed. */
export const HISTORY_LIMIT = 100;

export type History = { past: StudioScene[]; future: StudioScene[] };

/** Remembers `before` as the scene to go back to; a new step ends any redo trail. */
export const record = (history: History, before: StudioScene): History => ({
  past: [...history.past, before].slice(-HISTORY_LIMIT),
  future: [],
});

export function undo(history: History, current: StudioScene): { history: History; scene: StudioScene } | null {
  const scene = history.past.at(-1);
  if (!scene) return null;
  return { scene, history: { past: history.past.slice(0, -1), future: [current, ...history.future] } };
}

export function redo(history: History, current: StudioScene): { history: History; scene: StudioScene } | null {
  const [scene, ...future] = history.future;
  if (!scene) return null;
  return { scene, history: { past: [...history.past, current].slice(-HISTORY_LIMIT), future } };
}
```

```ts
// web/src/features/studio/studioStore.ts
import { createStore, useStore, type StoreApi } from 'zustand';
import { quatFromEuler, wrapEuler, type Vec3 } from './geometry/euler';
import { record, redo, undo, type History } from './history';
import { newPrimitive, PRIMITIVE_LABELS } from './model/defaults';
import type { PrimitiveType, SceneSettings, StudioObject, StudioScene } from './model/document';
import { newId } from './model/ids';

export type Tool = 'select' | 'move' | 'rotate' | 'scale';
export type Orientation = 'world' | 'local';

/** Where a duplicate or a paste lands relative to its original: beside it, not inside it. */
const OFFSET: Vec3 = [0.5, 0, 0.5];

/**
 * The studio's state: the document that is saved, and the session around it that is not.
 *
 * This replaces DesignBox's mesh.metadata and its dozen closure variables, several declared `var`
 * only so they could be read through `typeof x !== 'undefined'` before they existed. The engine
 * draws from here and writes back through the actions; the React side reads the same.
 *
 * Every document change goes through `commit`, which is what makes undo exact: a change outside a
 * gesture is one step, and a gesture — a gizmo drag — is one step however many moves it sent.
 */
export type StudioState = {
  scene: StudioScene | null;
  selection: string[];
  tool: Tool;
  orientation: Orientation;
  clipboard: StudioObject[];
  history: History;
  gestureBase: StudioScene | null;
  /** Counts document changes; the saver compares it with `savedRevision`. */
  revision: number;
  savedRevision: number;

  open: (scene: StudioScene, saved?: boolean) => void;
  close: () => void;
  addPrimitive: (type: PrimitiveType, at: Vec3) => string;
  updateObject: (id: string, patch: Partial<StudioObject>) => void;
  setEuler: (id: string, euler: Vec3) => void;
  rename: (id: string, name: string) => void;
  removeObjects: (ids: string[]) => void;
  duplicate: (ids: string[]) => string[];
  copy: (ids: string[]) => void;
  paste: () => string[];
  select: (ids: string[]) => void;
  setTool: (tool: Tool) => void;
  setOrientation: (orientation: Orientation) => void;
  updateSettings: (patch: Partial<SceneSettings>) => void;
  renameScene: (name: string) => void;
  beginGesture: () => void;
  endGesture: () => void;
  undo: () => void;
  redo: () => void;
  markSaved: (revision: number) => void;
};

export const isDirty = (state: Pick<StudioState, 'revision' | 'savedRevision'>) => state.revision !== state.savedRevision;

const plus = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** "Box 3": one more than the highest number already used for that kind. */
function nextName(scene: StudioScene, label: string) {
  const pattern = new RegExp(`^${label} (\\d+)$`);
  const used = scene.objects.map((o) => Number(o.name.match(pattern)?.[1] ?? 0));
  return `${label} ${Math.max(0, ...used) + 1}`;
}

export function createStudioStore(): StoreApi<StudioState> {
  return createStore<StudioState>()((set, get) => {
    /** Replaces the document and records the step the change makes, unless a gesture is under way. */
    const commit = (change: (scene: StudioScene) => StudioScene, session: Partial<StudioState> = {}) => {
      const { scene, gestureBase, history, revision } = get();
      if (!scene) return;
      const next = change(scene);
      if (next === scene) return;
      set({
        ...session,
        scene: next,
        history: gestureBase ? history : record(history, scene),
        revision: revision + 1,
      });
    };

    const mapObjects = (ids: Set<string>, change: (o: StudioObject) => StudioObject) => (scene: StudioScene) => ({
      ...scene,
      objects: scene.objects.map((o) => (ids.has(o.id) ? change(o) : o)),
    });

    const copies = (sources: StudioObject[], suffix: string) =>
      sources.map((o) => ({ ...o, id: newId(), name: suffix ? `${o.name} ${suffix}` : o.name, position: plus(o.position, OFFSET) }));

    return {
      scene: null,
      selection: [],
      tool: 'move',
      orientation: 'world',
      clipboard: [],
      history: { past: [], future: [] },
      gestureBase: null,
      revision: 0,
      savedRevision: 0,

      open: (scene, saved = true) =>
        set({
          scene,
          selection: [],
          history: { past: [], future: [] },
          gestureBase: null,
          revision: 0,
          savedRevision: saved ? 0 : -1,
        }),

      close: () => set({ scene: null, selection: [], history: { past: [], future: [] }, gestureBase: null }),

      addPrimitive: (type, at) => {
        const scene = get().scene;
        if (!scene) return '';
        const object = newPrimitive(type, scene.objects.length, at, nextName(scene, PRIMITIVE_LABELS[type]));
        commit((s) => ({ ...s, objects: [...s.objects, object] }), { selection: [object.id] });
        return object.id;
      },

      updateObject: (id, patch) => commit(mapObjects(new Set([id]), (o) => ({ ...o, ...patch }))),

      setEuler: (id, euler) => {
        const wrapped = wrapEuler(euler);
        commit(mapObjects(new Set([id]), (o) => ({ ...o, euler: wrapped, rotation: quatFromEuler(wrapped) })));
      },

      rename: (id, name) => {
        const trimmed = name.trim();
        if (trimmed) commit(mapObjects(new Set([id]), (o) => ({ ...o, name: trimmed })));
      },

      removeObjects: (ids) => {
        const gone = new Set(ids);
        commit((s) => ({ ...s, objects: s.objects.filter((o) => !gone.has(o.id)) }), {
          selection: get().selection.filter((id) => !gone.has(id)),
        });
      },

      duplicate: (ids) => {
        const scene = get().scene;
        if (!scene) return [];
        const made = copies(scene.objects.filter((o) => ids.includes(o.id)), 'copy');
        commit((s) => ({ ...s, objects: [...s.objects, ...made] }), { selection: made.map((o) => o.id) });
        return made.map((o) => o.id);
      },

      copy: (ids) => set({ clipboard: get().scene?.objects.filter((o) => ids.includes(o.id)) ?? [] }),

      paste: () => {
        const made = copies(get().clipboard, '');
        if (made.length === 0) return [];
        commit((s) => ({ ...s, objects: [...s.objects, ...made] }), { selection: made.map((o) => o.id), clipboard: made });
        return made.map((o) => o.id);
      },

      select: (ids) => set({ selection: ids }),
      setTool: (tool) => set({ tool }),
      setOrientation: (orientation) => set({ orientation }),

      updateSettings: (patch) => commit((s) => ({ ...s, settings: { ...s.settings, ...patch } })),

      renameScene: (name) => {
        const trimmed = name.trim();
        if (trimmed) commit((s) => ({ ...s, name: trimmed }));
      },

      beginGesture: () => set({ gestureBase: get().scene }),

      endGesture: () => {
        const { gestureBase, scene, history } = get();
        if (!gestureBase) return;
        set({ gestureBase: null, history: scene && scene !== gestureBase ? record(history, gestureBase) : history });
      },

      undo: () => {
        const { history, scene, revision, selection } = get();
        const step = scene && undo(history, scene);
        if (!step) return;
        const ids = new Set(step.scene.objects.map((o) => o.id));
        set({ scene: step.scene, history: step.history, revision: revision + 1, selection: selection.filter((id) => ids.has(id)) });
      },

      redo: () => {
        const { history, scene, revision, selection } = get();
        const step = scene && redo(history, scene);
        if (!step) return;
        const ids = new Set(step.scene.objects.map((o) => o.id));
        set({ scene: step.scene, history: step.history, revision: revision + 1, selection: selection.filter((id) => ids.has(id)) });
      },

      markSaved: (revision) => set({ savedRevision: revision }),
    };
  });
}

/** The console's one studio. Tests make their own with `createStudioStore`. */
export const studioStore = createStudioStore();

export const useStudio = <T,>(selector: (state: StudioState) => T): T => useStore(studioStore, selector);
```

- [ ] **Step 4: Run the tests**

Run: `cd /c/IT/mqtt-forge-studio/web && npx vitest run src/features/studio/history.test.ts src/features/studio/studioStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /c/IT/mqtt-forge-studio
git add web/src/features/studio/history.ts web/src/features/studio/history.test.ts web/src/features/studio/studioStore.ts web/src/features/studio/studioStore.test.ts
git commit -m "feat: the studio's scene lives in one store with explicit undo steps, so a gizmo drag is one step however many moves it sent rather than whatever landed after designbox's save debounce"
```

---

### Task 8: Studio API client

**Files:**
- Create: `web/src/api/studio.ts`, `web/src/api/studio.test.ts`
- Modify: `web/src/api/queryKeys.ts`
- Modify: `web/src/test/server.ts` (default handler)

**Interfaces:**
- Consumes: HTTP contract from Task 4; `StudioScene` (Task 6)
- Produces: `type StudioSceneSummary = { id: string; name: string; updatedAt: string }`; `listScenes()`, `getScene(id): Promise<unknown>`, `putScene(scene: StudioScene): Promise<void>`, `deleteScene(id): Promise<void>`, `uploadModel(blob: Blob, ext: string): Promise<{ key: string }>`, `isSceneUnknown(error)`; `queryKeys.studioScenes = ['studio', 'scenes']`

- [ ] **Step 1: Default msw handler** — in `web/src/test/server.ts`, add to `defaultHandlers` after the flows' two lines:

```ts
  http.get('/api/studio/scenes', () => HttpResponse.json([])),
  // A studio that finds no scenes starts one and saves it at once; every sweep that opens the
  // panel would otherwise fail on an unhandled request.
  http.put('/api/studio/scenes/:id', () => new HttpResponse(null, { status: 204 })),
```

and to `queryKeys.ts` after `flows`:

```ts
  studioScenes: ['studio', 'scenes'] as const,
```

- [ ] **Step 2: Write the failing test**

```ts
// web/src/api/studio.test.ts
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { blankScene } from '../features/studio/model/defaults';
import { server } from '../test/server';
import { deleteScene, getScene, isSceneUnknown, listScenes, putScene, uploadModel } from './studio';

describe('studio api', () => {
  it('lists, reads, saves and deletes scenes at their own addresses', async () => {
    const scene = blankScene('Cell');
    let saved: unknown;
    server.use(
      http.get('/api/studio/scenes', () => HttpResponse.json([{ id: scene.id, name: 'Cell', updatedAt: scene.updatedAt }])),
      http.get(`/api/studio/scenes/${scene.id}`, () => HttpResponse.json(scene)),
      http.put(`/api/studio/scenes/${scene.id}`, async ({ request }) => {
        saved = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
      http.delete(`/api/studio/scenes/${scene.id}`, () => new HttpResponse(null, { status: 204 })),
    );

    expect(await listScenes()).toEqual([{ id: scene.id, name: 'Cell', updatedAt: scene.updatedAt }]);
    expect(await getScene(scene.id)).toEqual(scene);
    await putScene(scene);
    expect(saved).toEqual(scene);
    await expect(deleteScene(scene.id)).resolves.toBeUndefined();
  });

  it('sends a model as raw bytes with its extension in the query', async () => {
    let seen: { ext: string | null; type: string | null; body: string } | undefined;
    server.use(
      http.post('/api/studio/models', async ({ request }) => {
        seen = { ext: new URL(request.url).searchParams.get('ext'), type: request.headers.get('content-type'), body: await request.text() };
        return HttpResponse.json({ key: 'k.stl' });
      }),
    );

    expect(await uploadModel(new Blob(['solid']), '.stl')).toEqual({ key: 'k.stl' });
    expect(seen).toEqual({ ext: '.stl', type: 'application/octet-stream', body: 'solid' });
  });

  it('tells a scene that is not there apart from other failures', async () => {
    server.use(
      http.get('/api/studio/scenes/gone', () =>
        HttpResponse.json({ status: 404, title: 'No scene', reason: 'sceneUnknown' }, { status: 404 })),
    );

    await expect(getScene('gone')).rejects.toSatisfy(isSceneUnknown);
  });
});
```

- [ ] **Step 3: Run to see it fail**

Run: `cd /c/IT/mqtt-forge-studio/web && npx vitest run src/api/studio.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

```ts
// web/src/api/studio.ts
import type { StudioScene } from '../features/studio/model/document';
import { ApiError } from '../lib/problemDetails';
import { json, request } from './client';

export type StudioSceneSummary = { id: string; name: string; updatedAt: string };

/** A model is the CAD file itself and can run to a hundred megabytes; the usual fifteen seconds is not enough. */
const UPLOAD_PATIENCE = { timeoutMs: 300_000 };

const scenePath = (id: string) => `/api/studio/scenes/${encodeURIComponent(id)}`;

export const listScenes = () => request<StudioSceneSummary[]>('/api/studio/scenes');

/** The scene as stored: unknown until `readSceneFile` has looked at it. */
export const getScene = (id: string) => request<unknown>(scenePath(id));

/** One scene per request, so two consoles on two scenes never write over each other. */
export const putScene = (scene: StudioScene) => request<void>(scenePath(scene.id), { method: 'PUT', ...json(scene) });

export const deleteScene = (id: string) => request<void>(scenePath(id), { method: 'DELETE' });

/** The bytes as the body, not a form: the server hashes the stream straight to disk. */
export const uploadModel = (blob: Blob, ext: string) =>
  request<{ key: string }>(
    `/api/studio/models?ext=${encodeURIComponent(ext)}`,
    { method: 'POST', body: blob, headers: { 'Content-Type': 'application/octet-stream' } },
    UPLOAD_PATIENCE,
  );

/** Another console deleted the scene since this one listed it. */
export const isSceneUnknown = (error: unknown): error is ApiError =>
  error instanceof ApiError && error.status === 404 && error.reason === 'sceneUnknown';
```

- [ ] **Step 5: Run the test**

Run: `cd /c/IT/mqtt-forge-studio/web && npx vitest run src/api/studio.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /c/IT/mqtt-forge-studio
git add web/src/api web/src/test/server.ts
git commit -m "feat: the console talks to /api/studio through one client file, sending models as raw bytes with a patience long enough for a whole machine's step file"
```

---

### Task 9: Engine — scene, primitives, materials, mesh reconciliation

**Files:**
- Create: `web/src/features/studio/engine/primitives.ts`
- Create: `web/src/features/studio/engine/materials.ts`
- Create: `web/src/features/studio/engine/meshes.ts`, `engine/meshes.test.ts`
- Create: `web/src/features/studio/engine/transform.ts`, `engine/transform.test.ts`

**Interfaces:**
- Consumes: document types (Task 6), `MATERIAL_PRESETS`, `DEFAULT_MATERIAL` (Task 6), `Vec3`, `wrapEuler` (Task 5)
- Produces:
  - `createShape(type: ObjectType, scene: Scene): Mesh`
  - `applyMaterial(material: PBRMaterial, object: StudioObject): void`; `PLACEHOLDER_COLOUR`
  - `class MeshRegistry { constructor(scene: Scene, onCreate?: (mesh: Mesh) => void); sync(objects: readonly StudioObject[]): void; mesh(id: string): Mesh | undefined; idOf(mesh: AbstractMesh | null): string | undefined; get size(): number; dispose(): void }`
  - `transformFromMesh(mesh: AbstractMesh): Pick<StudioObject, 'position' | 'rotation' | 'euler' | 'scaling'>`

- [ ] **Step 1: Write the failing tests** (Babylon's `NullEngine` runs the scene graph without WebGL, which is what jsdom has)

```ts
// web/src/features/studio/engine/meshes.test.ts
import { NullEngine, PBRMaterial, Scene } from '@babylonjs/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newPrimitive } from '../model/defaults';
import type { StudioObject } from '../model/document';
import { MeshRegistry } from './meshes';

let engine: NullEngine;
let scene: Scene;
let registry: MeshRegistry;

beforeEach(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
  registry = new MeshRegistry(scene);
});
afterEach(() => {
  registry.dispose();
  scene.dispose();
  engine.dispose();
});

const box = (patch: Partial<StudioObject> = {}): StudioObject => ({ ...newPrimitive('box', 0, [0, 0, 0], 'Box 1'), ...patch });

describe('MeshRegistry', () => {
  it('makes one mesh per object, placed and coloured as the document says', () => {
    const object = box({ position: [1, 2, 3], scaling: [2, 1, 1], color: '#ff0000' });
    registry.sync([object]);

    const mesh = registry.mesh(object.id)!;
    expect(mesh.position.asArray()).toEqual([1, 2, 3]);
    expect(mesh.scaling.asArray()).toEqual([2, 1, 1]);
    expect((mesh.material as PBRMaterial).albedoColor.toGammaSpace().toHexString()).toBe('#FF0000');
    expect(registry.idOf(mesh)).toBe(object.id);
  });

  it('updates a mesh in place when its object changes, and only then', () => {
    const object = box();
    registry.sync([object]);
    const mesh = registry.mesh(object.id)!;

    registry.sync([{ ...object, position: [5, 0, 0] }]);

    expect(registry.mesh(object.id)).toBe(mesh);
    expect(mesh.position.x).toBe(5);
  });

  it('disposes the mesh and its material when the object goes', () => {
    const object = box();
    registry.sync([object]);
    const mesh = registry.mesh(object.id)!;
    const material = mesh.material!;

    registry.sync([]);

    expect(mesh.isDisposed()).toBe(true);
    expect(scene.materials).not.toContain(material);
    expect(registry.size).toBe(0);
  });

  it('hides a hidden object and makes a frozen one unpickable', () => {
    const object = box({ hidden: true, frozen: true });
    registry.sync([object]);
    const mesh = registry.mesh(object.id)!;
    expect(mesh.isEnabled()).toBe(false);
    expect(mesh.isPickable).toBe(false);
  });

  // Phase 1 cannot load model files yet; the object must still be there to select and move.
  it('draws a model as a translucent placeholder', () => {
    const model: StudioObject = { ...box(), type: 'model', model: { key: 'k.glb', ext: '.glb' } };
    registry.sync([model]);
    expect(registry.mesh(model.id)!.material!.alpha).toBeLessThan(1);
  });

  it('dispose leaves nothing of its own in the scene', () => {
    registry.sync([box(), box({ id: 'b2' })]);
    registry.dispose();
    expect(scene.meshes).toHaveLength(0);
    expect(scene.materials).toHaveLength(0);
  });
});
```

```ts
// web/src/features/studio/engine/transform.test.ts
import { MeshBuilder, NullEngine, Quaternion, Scene, Vector3 } from '@babylonjs/core';
import { describe, expect, it } from 'vitest';
import { transformFromMesh } from './transform';

describe('transformFromMesh', () => {
  it('reads position, rotation, wrapped angles and scale back off a mesh', () => {
    const scene = new Scene(new NullEngine());
    const mesh = MeshBuilder.CreateBox('b', {}, scene);
    mesh.position = new Vector3(1, 2, 3);
    mesh.rotationQuaternion = Quaternion.FromEulerAngles(0, Math.PI / 2, 0);
    mesh.scaling = new Vector3(2, 2, 2);

    const t = transformFromMesh(mesh);

    expect(t.position).toEqual([1, 2, 3]);
    expect(t.euler[1]).toBeCloseTo(Math.PI / 2);
    expect(t.rotation[3]).toBeCloseTo(Math.cos(Math.PI / 4));
    expect(t.scaling).toEqual([2, 2, 2]);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `cd /c/IT/mqtt-forge-studio/web && npx vitest run src/features/studio/engine`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```ts
// web/src/features/studio/engine/primitives.ts
import { MeshBuilder, type Mesh, type Scene } from '@babylonjs/core';
import type { ObjectType } from '../model/document';

/**
 * The shapes, each one metre across at scale 1 — the sizes `restHeight` in model/defaults.ts
 * assumes. A model is a half-metre box until Phase 2 can draw the file it names.
 */
const SHAPES: Record<ObjectType, (scene: Scene) => Mesh> = {
  box: (s) => MeshBuilder.CreateBox('', { size: 1 }, s),
  sphere: (s) => MeshBuilder.CreateSphere('', { diameter: 1, segments: 32 }, s),
  cylinder: (s) => MeshBuilder.CreateCylinder('', { height: 1, diameter: 1, tessellation: 48 }, s),
  cone: (s) => MeshBuilder.CreateCylinder('', { height: 1, diameterTop: 0, diameterBottom: 1, tessellation: 48 }, s),
  pyramid: (s) => MeshBuilder.CreateCylinder('', { height: 1, diameterTop: 0, diameterBottom: 1.2, tessellation: 4 }, s),
  torus: (s) => MeshBuilder.CreateTorus('', { diameter: 1, thickness: 0.3, tessellation: 48 }, s),
  capsule: (s) => MeshBuilder.CreateCapsule('', { height: 1.2, radius: 0.3 }, s),
  wall: (s) => MeshBuilder.CreateBox('', { width: 2, height: 1.5, depth: 0.15 }, s),
  model: (s) => MeshBuilder.CreateBox('', { size: 0.5 }, s),
};

export const createShape = (type: ObjectType, scene: Scene): Mesh => (SHAPES[type] ?? SHAPES.box)(scene);
```

```ts
// web/src/features/studio/engine/materials.ts
import { Color3, type PBRMaterial } from '@babylonjs/core';
import { DEFAULT_MATERIAL } from '../model/defaults';
import type { StudioObject } from '../model/document';

export const PLACEHOLDER_COLOUR = '#8a8f98';
/** How see-through a transparent object, or a model's placeholder, is drawn. */
const SEE_THROUGH = 0.35;

/** Colour, metal and roughness from the document onto the object's own material. */
export function applyMaterial(material: PBRMaterial, object: StudioObject) {
  const placeholder = object.type === 'model';
  const spec = object.mat ?? DEFAULT_MATERIAL;

  material.albedoColor = Color3.FromHexString(placeholder ? PLACEHOLDER_COLOUR : (object.color ?? PLACEHOLDER_COLOUR)).toLinearSpace();
  material.metallic = placeholder ? 0 : spec.metal;
  material.roughness = placeholder ? 0.8 : spec.rough;
  material.alpha = placeholder || object.transparent ? SEE_THROUGH : 1;
}
```

```ts
// web/src/features/studio/engine/meshes.ts
import { PBRMaterial, Quaternion, type AbstractMesh, type Mesh, type Scene } from '@babylonjs/core';
import type { StudioObject } from '../model/document';
import { applyMaterial } from './materials';
import { createShape } from './primitives';

type Entry = { object: StudioObject; mesh: Mesh; material: PBRMaterial };

/**
 * The meshes, kept in step with the document's objects by id.
 *
 * DesignBox mapped document to mesh in two places — loading and undo — and the two had drifted
 * (undo skipped transparency and the persistent id). There is one mapping now, `place`, and it
 * runs only for an object whose record changed: the store's updates are immutable, so an object
 * nobody touched is the same reference it was, and comparing references is the whole diff.
 */
export class MeshRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly scene: Scene;
  private readonly onCreate: (mesh: Mesh) => void;

  constructor(scene: Scene, onCreate: (mesh: Mesh) => void = () => {}) {
    this.scene = scene;
    this.onCreate = onCreate;
  }

  get size() {
    return this.entries.size;
  }

  sync(objects: readonly StudioObject[]) {
    const seen = new Set<string>();

    for (const object of objects) {
      seen.add(object.id);
      const entry = this.entries.get(object.id);

      if (!entry || entry.object.type !== object.type) {
        if (entry) this.remove(object.id);
        this.create(object);
      } else if (entry.object !== object) {
        place(entry, object);
      }
    }

    for (const id of [...this.entries.keys()]) if (!seen.has(id)) this.remove(id);
  }

  mesh(id: string) {
    return this.entries.get(id)?.mesh;
  }

  /** The object a picked mesh draws, looking up through parents for a model's sub-meshes. */
  idOf(mesh: AbstractMesh | null): string | undefined {
    for (let node: AbstractMesh | null = mesh; node; node = node.parent as AbstractMesh | null) {
      const id = (node.metadata as { studioId?: string } | null)?.studioId;
      if (id && this.entries.has(id)) return id;
    }
    return undefined;
  }

  dispose() {
    for (const id of [...this.entries.keys()]) this.remove(id);
  }

  private create(object: StudioObject) {
    const mesh = createShape(object.type, this.scene);
    mesh.metadata = { studioId: object.id };
    mesh.rotationQuaternion = new Quaternion();
    const material = new PBRMaterial(`studio-${object.id}`, this.scene);
    mesh.material = material;

    const entry = { object, mesh, material };
    place(entry, object);
    this.entries.set(object.id, entry);
    this.onCreate(mesh);
  }

  private remove(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.mesh.dispose();
    entry.material.dispose();
    this.entries.delete(id);
  }
}

function place(entry: Entry, object: StudioObject) {
  const { mesh, material } = entry;
  mesh.name = object.name;
  mesh.position.set(...object.position);
  mesh.rotationQuaternion!.set(...object.rotation);
  mesh.scaling.set(...object.scaling);
  mesh.setEnabled(!object.hidden);
  mesh.isPickable = !object.frozen;
  applyMaterial(material, object);
  entry.object = object;
}
```

```ts
// web/src/features/studio/engine/transform.ts
import { Quaternion, type AbstractMesh } from '@babylonjs/core';
import { wrapEuler, type Vec3 } from '../geometry/euler';
import type { StudioObject } from '../model/document';

/** What a gizmo did to a mesh, as the document's fields — the way back from Babylon to the store. */
export function transformFromMesh(mesh: AbstractMesh): Pick<StudioObject, 'position' | 'rotation' | 'euler' | 'scaling'> {
  const q = mesh.rotationQuaternion ?? Quaternion.FromEulerVector(mesh.rotation);
  const e = q.toEulerAngles();

  return {
    position: mesh.position.asArray() as Vec3,
    rotation: [q.x, q.y, q.z, q.w],
    euler: wrapEuler([e.x, e.y, e.z]),
    scaling: mesh.scaling.asArray() as Vec3,
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd /c/IT/mqtt-forge-studio/web && npx vitest run src/features/studio/engine`
Expected: PASS. (`isEnabled()` returns false for a disabled mesh; if the `scene.materials` assertion fails because Babylon keeps a default material, assert `scene.materials.filter(m => m.name.startsWith('studio-'))` is empty instead.)

- [ ] **Step 5: Commit**

```bash
cd /c/IT/mqtt-forge-studio
git add web/src/features/studio/engine
git commit -m "feat: studio meshes follow the document through one mapping that runs only for objects whose record changed, where designbox had two that had drifted apart, and a model stands in as a translucent box until its loader arrives"
```

---

### Task 10: Engine — camera, rendering, picking, gizmos, and `StudioEngine`

**Files:**
- Create: `web/src/features/studio/engine/camera.ts`, `engine/camera.test.ts`
- Create: `web/src/features/studio/engine/rendering.ts`
- Create: `web/src/features/studio/engine/picking.ts`
- Create: `web/src/features/studio/engine/gizmos.ts`
- Create: `web/src/features/studio/engine/StudioEngine.ts`, `engine/StudioEngine.test.ts`
- Create: `web/public/studio/environment.env` (copy)

**Interfaces:**
- Consumes: `MeshRegistry`, `transformFromMesh` (Task 9); `StudioState`, `createStudioStore` (Task 7); `snapTo` not needed (gizmos snap natively)
- Produces:
  - `CAMERA` constants; `createCamera(scene, canvas: HTMLCanvasElement | null): ArcRotateCamera`; `tuneCamera(camera, heightPx: number): void`; `focusOn(camera, mesh): void`
  - `setupRendering(scene, camera, options: { environmentUrl?: string; shadows: boolean }): { shadows: ShadowGenerator | null; dispose(): void }`
  - `attachPicking(scene, registry, onPick: (id: string | null) => void): () => void`
  - `class GizmoBridge { constructor(scene, registry, store: StoreApi<StudioState>); update(state: StudioState): void; dispose(): void }`
  - `class WebGLUnavailable extends Error`; `hasWebGL(): boolean`
  - `class StudioEngine { static open(canvas, store, onStatus?): StudioEngine; constructor(engine: AbstractEngine, store, options?: { canvas?: HTMLCanvasElement; environmentUrl?: string; onStatus?: (s: 'ready' | 'lost') => void }); readonly scene: Scene; readonly registry: MeshRegistry; viewCentre(): Vec3; focusSelection(): void; dispose(): void }`

- [ ] **Step 1: Copy the environment lighting**

Run: `mkdir -p /c/IT/mqtt-forge-studio/web/public/studio && cp /c/IT/DesignBox/assets/environment.env /c/IT/mqtt-forge-studio/web/public/studio/environment.env`

- [ ] **Step 2: Write the failing tests**

```ts
// web/src/features/studio/engine/camera.test.ts
import { MeshBuilder, NullEngine, Scene, Vector3 } from '@babylonjs/core';
import { describe, expect, it } from 'vitest';
import { CAMERA, createCamera, focusOn, tuneCamera } from './camera';

describe('camera', () => {
  it('never lets the camera go below the floor or the target under it', () => {
    const scene = new Scene(new NullEngine());
    const camera = createCamera(scene, null);
    camera.target = new Vector3(0, -2, 0);
    camera.beta = Math.PI - 0.01;

    tuneCamera(camera, 600);

    expect(camera.target.y).toBe(0);
    expect(camera.position.y).toBeGreaterThanOrEqual(CAMERA.minY - 1e-6);
  });

  it('pans one screen pixel per pixel at the target depth', () => {
    const scene = new Scene(new NullEngine());
    const camera = createCamera(scene, null);
    camera.radius = 10;
    tuneCamera(camera, 500);
    const worldPerPixel = (2 * 10 * Math.tan(camera.fov / 2)) / 500;
    expect(camera.panningSensibility).toBeCloseTo(1 / (worldPerPixel * (1 - camera.panningInertia)));
  });

  it('frames a mesh when focusing on it', () => {
    const scene = new Scene(new NullEngine());
    const camera = createCamera(scene, null);
    const box = MeshBuilder.CreateBox('b', { size: 2 }, scene);
    box.position.set(5, 1, 5);

    focusOn(camera, box);

    expect(camera.target.asArray()).toEqual([5, 1, 5]);
    expect(camera.radius).toBeGreaterThan(2);
  });
});
```

```ts
// web/src/features/studio/engine/StudioEngine.test.ts
import { NullEngine } from '@babylonjs/core';
import { describe, expect, it } from 'vitest';
import { blankScene } from '../model/defaults';
import { createStudioStore } from '../studioStore';
import { hasWebGL, StudioEngine } from './StudioEngine';

const opened = () => {
  const store = createStudioStore();
  store.getState().open(blankScene('Cell'));
  const studio = new StudioEngine(new NullEngine(), store);
  return { store, studio };
};

describe('StudioEngine', () => {
  it('draws what is in the store and follows it', () => {
    const { store, studio } = opened();
    const id = store.getState().addPrimitive('box', [0, 0, 0]);
    expect(studio.registry.mesh(id)).toBeDefined();

    store.getState().removeObjects([id]);
    expect(studio.registry.mesh(id)).toBeUndefined();
    studio.dispose();
  });

  it('draws a scene that was already open when it started', () => {
    const store = createStudioStore();
    store.getState().open(blankScene('Cell'));
    const id = store.getState().addPrimitive('sphere', [0, 0, 0]);

    const studio = new StudioEngine(new NullEngine(), store);
    expect(studio.registry.mesh(id)).toBeDefined();
    studio.dispose();
  });

  it('stops following the store once disposed', () => {
    const { store, studio } = opened();
    studio.dispose();
    expect(() => store.getState().addPrimitive('box', [0, 0, 0])).not.toThrow();
    expect(studio.registry.size).toBe(0);
  });

  it('puts new shapes where the camera is looking, on the ground', () => {
    const { studio } = opened();
    expect(studio.viewCentre()).toEqual([0, 0, 0]);
    studio.dispose();
  });

  // jsdom has no WebGL; the panel says so rather than throwing inside Babylon.
  it('knows when there is no WebGL to draw with', () => {
    expect(hasWebGL()).toBe(false);
  });
});
```

- [ ] **Step 3: Run to see them fail**

Run: `cd /c/IT/mqtt-forge-studio/web && npx vitest run src/features/studio/engine/camera.test.ts src/features/studio/engine/StudioEngine.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Camera**

```ts
// web/src/features/studio/engine/camera.ts
import { ArcRotateCamera, Vector3, type AbstractMesh, type ArcRotateCameraMouseWheelInput, type Scene } from '@babylonjs/core';

export const CAMERA = {
  alpha: -Math.PI / 4,
  beta: Math.PI / 3.2,
  radius: 14,
  minRadius: 0.5,
  maxRadius: 200,
  /** The lowest the eye may go, so the floor is never seen from underneath. */
  minY: 0.05,
  /** Short of straight up from below, where the view's direction stops being defined. */
  betaMax: Math.PI - 0.05,
  baseAngular: 1000,
  rotateRefRadius: 10,
  near: 0.1,
  far: 300,
} as const;

/**
 * The orbit camera. With a canvas it takes the pointer, zooms towards the cursor rather than the
 * middle of the screen, and leaves the arrow keys alone — they nudge the selection.
 */
export function createCamera(scene: Scene, canvas: HTMLCanvasElement | null): ArcRotateCamera {
  const camera = new ArcRotateCamera('studio-camera', CAMERA.alpha, CAMERA.beta, CAMERA.radius, Vector3.Zero(), scene);
  camera.lowerRadiusLimit = CAMERA.minRadius;
  camera.upperRadiusLimit = CAMERA.maxRadius;
  camera.wheelDeltaPercentage = 0.01;
  camera.minZ = CAMERA.near;
  camera.maxZ = CAMERA.far;

  if (canvas) {
    camera.attachControl(canvas, true);
    camera.inputs.removeByType('ArcRotateCameraKeyboardMoveInput');
    const wheel = camera.inputs.attached.mousewheel as ArcRotateCameraMouseWheelInput | undefined;
    if (wheel) wheel.zoomToMouseLocation = true;
  }

  return camera;
}

/**
 * Called before every frame. Speeds follow distance — fixed ones were far too fast up close — and
 * the camera is kept above the floor. Allocates nothing, since it runs sixty times a second.
 */
export function tuneCamera(camera: ArcRotateCamera, heightPx: number) {
  if (camera.target.y < 0) camera.target.y = 0;

  // Eye height is target.y + r·cos(β) ≥ minY, so β ≤ acos((minY − target.y) / r).
  const c = (CAMERA.minY - camera.target.y) / Math.max(1e-6, camera.radius);
  camera.upperBetaLimit = c >= 1 ? 0.02 : Math.min(CAMERA.betaMax, Math.acos(Math.max(-1, c)));
  if (camera.beta > camera.upperBetaLimit) camera.beta = camera.upperBetaLimit;

  // The point under the cursor moves with the cursor: one pixel of drag, one pixel of world at the
  // target's depth. Babylon multiplies every input by 1/(1−inertia), so that is taken back out.
  const worldPerPixel = (2 * camera.radius * Math.tan(camera.fov / 2)) / Math.max(1, heightPx);
  camera.panningSensibility = 1 / (worldPerPixel * (1 - camera.panningInertia));

  const slow = Math.min(3, Math.max(1, Math.sqrt(CAMERA.rotateRefRadius / camera.radius)));
  camera.angularSensibilityX = camera.angularSensibilityY = CAMERA.baseAngular * slow;
  camera.minZ = Math.min(CAMERA.near, Math.max(0.01, camera.radius * 0.02));
}

/** Looks at the mesh from far enough away to see all of it. */
export function focusOn(camera: ArcRotateCamera, mesh: AbstractMesh) {
  const { min, max } = mesh.getHierarchyBoundingVectors(true);
  camera.setTarget(min.add(max).scaleInPlace(0.5));
  camera.radius = Math.max(CAMERA.minRadius * 2, max.subtract(min).length() * 1.5);
}
```

- [ ] **Step 5: Rendering** (lights, shadows, grid, environment) — ported from DesignBox lines 304–448 without the shader patch and with no per-frame allocations.

```ts
// web/src/features/studio/engine/rendering.ts
import { Color3, Color4, CubeTexture, DirectionalLight, HemisphericLight, MeshBuilder, ShadowGenerator, Vector3, type ArcRotateCamera, type Scene } from '@babylonjs/core';
import { GridMaterial, ShadowOnlyMaterial } from '@babylonjs/materials';

const GROUND_SIZE = 200;
const SHADOW_MAP_SIZE = 2048;
/** How far back along the light the sun stands from what it lights. */
const SUN_DISTANCE = 150;
/** Fine grid spacings, metres; the finest that stays ten pixels apart on screen is drawn. */
const GRID_STEPS = [0.001, 0.01, 0.1, 1, 10];
const GRID_MIN_PX = 10;

/**
 * Lights, the ground grid, a shadow-only layer just above it, and reflections from an environment
 * map. The shadow area follows the camera's target rather than covering the whole floor, so shadows
 * stay sharp up close; its centre snaps to the shadow map's texel so they do not shimmer in a pan.
 */
export function setupRendering(scene: Scene, camera: ArcRotateCamera, options: { environmentUrl?: string; shadows: boolean }) {
  scene.clearColor = new Color4(0.08, 0.09, 0.11, 1);

  const hemi = new HemisphericLight('studio-hemi', new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.55;
  hemi.groundColor = new Color3(0.2, 0.2, 0.25);

  const sun = new DirectionalLight('studio-sun', new Vector3(-1, -2, -1.2), scene);
  sun.intensity = 0.9;
  sun.autoUpdateExtends = false;
  sun.autoCalcShadowZBounds = false;
  sun.shadowMinZ = 1;
  sun.shadowMaxZ = 300;

  const ground = MeshBuilder.CreateGround('studio-ground', { width: GROUND_SIZE, height: GROUND_SIZE }, scene);
  ground.isPickable = false;
  const grid = new GridMaterial('studio-grid', scene);
  grid.gridRatio = 1;
  grid.majorUnitFrequency = 10;
  grid.minorUnitVisibility = 0.35;
  grid.mainColor = new Color3(0.22, 0.23, 0.27);
  grid.lineColor = new Color3(0.45, 0.48, 0.56);
  ground.material = grid;

  let shadows: ShadowGenerator | null = null;
  const catcher = MeshBuilder.CreateGround('studio-shadows', { width: GROUND_SIZE, height: GROUND_SIZE }, scene);
  catcher.position.y = 0.01;
  catcher.isPickable = false;
  catcher.receiveShadows = true;
  const shadowMaterial = new ShadowOnlyMaterial('studio-shadow-material', scene);
  shadowMaterial.activeLight = sun;
  shadowMaterial.alpha = 0.45;
  catcher.material = shadowMaterial;

  if (options.shadows) {
    shadows = new ShadowGenerator(SHADOW_MAP_SIZE, sun);
    shadows.usePercentageCloserFiltering = true;
    shadows.bias = 0.0005;
    shadows.normalBias = 0.01;
  }

  // Worked out once: the plane square to the light the shadow area is laid out in.
  const sunDir = sun.direction.clone().normalize();
  const right = Vector3.Cross(Vector3.Up(), sunDir).normalize();
  const up = Vector3.Cross(sunDir, right).normalize();
  const centre = new Vector3();
  const scratch = new Vector3();
  let shadowKey = '';
  let gridShown = 0;

  const frame = scene.onBeforeRenderObservable.add(() => {
    const perPx = (2 * camera.radius * Math.tan(camera.fov / 2)) / Math.max(1, scene.getEngine().getRenderHeight());
    const step = GRID_STEPS.find((g) => g / perPx >= GRID_MIN_PX) ?? GRID_STEPS[GRID_STEPS.length - 1];
    if (step !== gridShown) grid.gridRatio = gridShown = step;

    const half = Math.min(GROUND_SIZE / 2, Math.max(4, camera.radius * 1.4));
    const texel = (2 * half) / SHADOW_MAP_SIZE;
    const t = camera.target;
    const cr = Math.round(Vector3.Dot(t, right) / texel) * texel;
    const cu = Math.round(Vector3.Dot(t, up) / texel) * texel;
    const key = `${half}|${cr}|${cu}`;
    if (key === shadowKey) return;
    shadowKey = key;

    centre.copyFrom(right).scaleInPlace(cr);
    centre.addInPlace(scratch.copyFrom(up).scaleInPlace(cu));
    centre.addInPlace(scratch.copyFrom(sunDir).scaleInPlace(Vector3.Dot(t, sunDir)));
    sun.position.copyFrom(centre).subtractInPlace(scratch.copyFrom(sunDir).scaleInPlace(SUN_DISTANCE));
    sun.orthoLeft = sun.orthoBottom = -half;
    sun.orthoRight = sun.orthoTop = half;
  });

  let environment: CubeTexture | null = null;
  if (options.environmentUrl) {
    environment = new CubeTexture(
      options.environmentUrl,
      scene,
      null,
      false,
      null,
      () => {
        scene.environmentTexture = environment;
        scene.environmentIntensity = 0.75;
      },
      // Without reflections metal turns dark; the fill light makes up some of the difference.
      () => {
        console.warn('The studio lighting file could not be loaded; drawing without reflections.');
        hemi.intensity = 0.8;
      },
      undefined,
      true,
    );
  }

  return {
    shadows,
    dispose: () => {
      scene.onBeforeRenderObservable.remove(frame);
      environment?.dispose();
    },
  };
}
```

- [ ] **Step 6: Picking and gizmos**

```ts
// web/src/features/studio/engine/picking.ts
import { PointerEventTypes, type Scene } from '@babylonjs/core';
import type { MeshRegistry } from './meshes';

/** Further than this between press and release is a camera drag, not a click. */
const CLICK_SLOP_PX = 4;

/** A click on an object selects it; a click on nothing clears the selection. Answers its own detach. */
export function attachPicking(scene: Scene, registry: MeshRegistry, onPick: (id: string | null) => void) {
  let downX = 0;
  let downY = 0;

  const observer = scene.onPointerObservable.add((info) => {
    const event = info.event as PointerEvent;
    if (event.button !== 0) return;

    if (info.type === PointerEventTypes.POINTERDOWN) {
      downX = event.clientX;
      downY = event.clientY;
      return;
    }
    if (info.type !== PointerEventTypes.POINTERUP) return;
    if (Math.hypot(event.clientX - downX, event.clientY - downY) > CLICK_SLOP_PX) return;

    const hit = scene.pick(scene.pointerX, scene.pointerY, (mesh) => mesh.isPickable && registry.idOf(mesh) !== undefined);
    onPick(hit?.hit ? (registry.idOf(hit.pickedMesh) ?? null) : null);
  });

  return () => scene.onPointerObservable.remove(observer);
}
```

```ts
// web/src/features/studio/engine/gizmos.ts
import { GizmoManager, type Mesh, type Scene } from '@babylonjs/core';
import type { StoreApi } from 'zustand';
import { degToRad } from '../units/units';
import type { StudioState } from '../studioStore';
import type { MeshRegistry } from './meshes';
import { transformFromMesh } from './transform';

/**
 * The move, rotate and scale handles on the selected object, and the way their drags reach the
 * store. A drag is a gesture: it opens one undo step when it starts and closes it when it ends, and
 * every move in between writes the mesh's transform back to the document.
 */
export class GizmoBridge {
  private readonly manager: GizmoManager;
  private readonly registry: MeshRegistry;
  private readonly store: StoreApi<StudioState>;
  private attached: { id: string; mesh: Mesh } | null = null;
  private readonly wired = new WeakSet<object>();

  constructor(scene: Scene, registry: MeshRegistry, store: StoreApi<StudioState>) {
    this.registry = registry;
    this.store = store;
    this.manager = new GizmoManager(scene);
    this.manager.usePointerToAttachGizmos = false;
  }

  update(state: StudioState) {
    const id = state.selection.length === 1 ? state.selection[0] : null;
    const mesh = id ? this.registry.mesh(id) : undefined;
    const object = id ? state.scene?.objects.find((o) => o.id === id) : undefined;
    const usable = mesh && object && !object.frozen && !object.hidden;

    this.attached = usable ? { id: id!, mesh } : null;
    this.manager.attachToMesh(usable ? mesh : null);

    this.manager.positionGizmoEnabled = state.tool === 'move';
    this.manager.rotationGizmoEnabled = state.tool === 'rotate';
    this.manager.scaleGizmoEnabled = state.tool === 'scale';

    const settings = state.scene?.settings;
    const { gizmos } = this.manager;
    if (gizmos.positionGizmo) {
      gizmos.positionGizmo.snapDistance = settings?.snap ? settings.moveStep : 0;
      gizmos.positionGizmo.updateGizmoRotationToMatchAttachedMesh = state.orientation === 'local';
      this.wire(gizmos.positionGizmo);
    }
    if (gizmos.rotationGizmo) {
      gizmos.rotationGizmo.snapDistance = settings?.snap ? degToRad(settings.rotateStep) : 0;
      gizmos.rotationGizmo.updateGizmoRotationToMatchAttachedMesh = state.orientation === 'local';
      this.wire(gizmos.rotationGizmo);
    }
    if (gizmos.scaleGizmo) {
      gizmos.scaleGizmo.snapDistance = settings?.snap ? 0.1 : 0;
      this.wire(gizmos.scaleGizmo);
    }
  }

  dispose() {
    this.manager.dispose();
  }

  // Each gizmo is made the first time its tool is chosen, so its drags are hooked up then, once.
  private wire(gizmo: { onDragStartObservable: { add(fn: () => void): unknown }; onDragObservable: { add(fn: () => void): unknown }; onDragEndObservable: { add(fn: () => void): unknown } }) {
    if (this.wired.has(gizmo)) return;
    this.wired.add(gizmo);

    gizmo.onDragStartObservable.add(() => this.store.getState().beginGesture());
    gizmo.onDragObservable.add(() => this.writeBack());
    gizmo.onDragEndObservable.add(() => {
      this.writeBack();
      this.store.getState().endGesture();
    });
  }

  private writeBack() {
    if (this.attached) this.store.getState().updateObject(this.attached.id, transformFromMesh(this.attached.mesh));
  }
}
```

- [ ] **Step 7: `StudioEngine`**

```ts
// web/src/features/studio/engine/StudioEngine.ts
import { Engine, Scene, type AbstractEngine, type ArcRotateCamera } from '@babylonjs/core';
import type { StoreApi } from 'zustand';
import type { Vec3 } from '../geometry/euler';
import type { StudioState } from '../studioStore';
import { createCamera, focusOn, tuneCamera } from './camera';
import { GizmoBridge } from './gizmos';
import { MeshRegistry } from './meshes';
import { attachPicking } from './picking';
import { setupRendering } from './rendering';

/** Thrown when the browser cannot give the studio a WebGL context, so the panel can say so. */
export class WebGLUnavailable extends Error {
  constructor(cause?: unknown) {
    super('This browser cannot draw 3D: WebGL is turned off or not available.', { cause });
  }
}

/** Asked before Babylon is, which would otherwise try for a context and throw from deep inside. */
export const hasWebGL = () => typeof WebGLRenderingContext !== 'undefined';

type Options = { canvas?: HTMLCanvasElement; environmentUrl?: string; onStatus?: (status: 'ready' | 'lost') => void };

/**
 * The studio's 3D side: one Babylon engine, scene and camera, drawing whatever the store holds.
 *
 * It owns nothing the store does not. Meshes are made, moved and disposed by following the store;
 * the pointer and the gizmos change the store through its actions and never a mesh directly — so
 * undo, saving and the inspector all see one truth. Everything it creates goes in `dispose`, which
 * the panel calls on close: DesignBox ran once per page and had no way to be taken down.
 *
 * Without a canvas (tests, under Babylon's NullEngine) it draws the scene graph and nothing that
 * needs a pointer or a GPU: no controls, picking, gizmos, shadows or environment.
 */
export class StudioEngine {
  readonly scene: Scene;
  readonly registry: MeshRegistry;
  private readonly engine: AbstractEngine;
  private readonly store: StoreApi<StudioState>;
  private readonly camera: ArcRotateCamera;
  private readonly teardown: Array<() => void> = [];

  static open(canvas: HTMLCanvasElement, store: StoreApi<StudioState>, onStatus?: Options['onStatus']) {
    if (!hasWebGL()) throw new WebGLUnavailable();

    let engine: Engine;
    try {
      // The last argument draws at the screen's own pixel density, so edges stay sharp.
      engine = new Engine(canvas, true, { stencil: true }, true);
    } catch (error) {
      throw new WebGLUnavailable(error);
    }

    return new StudioEngine(engine, store, { canvas, environmentUrl: '/studio/environment.env', onStatus });
  }

  constructor(engine: AbstractEngine, store: StoreApi<StudioState>, options: Options = {}) {
    this.engine = engine;
    this.store = store;
    const { canvas } = options;
    this.scene = new Scene(engine);
    this.camera = createCamera(this.scene, canvas ?? null);

    const rendering = setupRendering(this.scene, this.camera, { environmentUrl: options.environmentUrl, shadows: !!canvas });
    this.teardown.push(rendering.dispose);

    this.registry = new MeshRegistry(this.scene, (mesh) => rendering.shadows?.addShadowCaster(mesh));
    this.teardown.push(() => this.registry.dispose());

    const tune = this.scene.onBeforeRenderObservable.add(() => tuneCamera(this.camera, engine.getRenderHeight()));
    this.teardown.push(() => this.scene.onBeforeRenderObservable.remove(tune));

    const gizmos = canvas ? new GizmoBridge(this.scene, this.registry, store) : null;
    if (gizmos) this.teardown.push(() => gizmos.dispose());

    if (canvas) {
      this.teardown.push(attachPicking(this.scene, this.registry, (id) => store.getState().select(id ? [id] : [])));

      const resize = new ResizeObserver(() => engine.resize());
      resize.observe(canvas);
      this.teardown.push(() => resize.disconnect());

      const lost = engine.onContextLostObservable.add(() => options.onStatus?.('lost'));
      const restored = engine.onContextRestoredObservable.add(() => options.onStatus?.('ready'));
      this.teardown.push(() => {
        engine.onContextLostObservable.remove(lost);
        engine.onContextRestoredObservable.remove(restored);
      });

      engine.runRenderLoop(() => this.scene.render());
      this.teardown.push(() => engine.stopRenderLoop());
    }

    const follow = (state: StudioState, previous?: StudioState) => {
      if (state.scene?.objects !== previous?.scene?.objects) this.registry.sync(state.scene?.objects ?? []);
      gizmos?.update(state);
    };
    follow(store.getState());
    this.teardown.push(store.subscribe(follow));

    options.onStatus?.('ready');
  }

  /** Where the camera is looking, put down on the ground: where a new shape lands. */
  viewCentre(): Vec3 {
    const { x, z } = this.camera.target;
    return [x, 0, z];
  }

  focusSelection() {
    const [id] = this.store.getState().selection;
    const mesh = id ? this.registry.mesh(id) : undefined;
    if (mesh) focusOn(this.camera, mesh);
  }

  dispose() {
    // Last made, first undone: the store subscription goes before the meshes it would sync.
    for (const undo of this.teardown.reverse()) undo();
    this.teardown.length = 0;
    this.scene.dispose();
    this.engine.dispose();
  }
}
```

- [ ] **Step 8: Run the tests**

Run: `cd /c/IT/mqtt-forge-studio/web && npx vitest run src/features/studio/engine`
Expected: PASS. If `GridMaterial`/`ShadowOnlyMaterial` throw under NullEngine, guard their creation with `if (options.shadows)`-style flag named `drawn` (true only with a canvas) and keep the ground plain under tests; re-run.

- [ ] **Step 9: Commit**

```bash
cd /c/IT/mqtt-forge-studio
git add web/src/features/studio/engine web/public/studio
git commit -m "feat: the studio engine is one class that draws the store's scene, sends picks and gizmo drags back through its actions as single undo steps, and takes down everything it made when the panel closes, which designbox's page-long script never could"
```

---

### Task 11: Number field, toolbar, outliner, inspector

**Files:**
- Create: `web/src/features/studio/ui/NumberField.tsx`, `ui/NumberField.test.tsx`
- Create: `web/src/features/studio/ui/Toolbar.tsx`, `ui/Toolbar.module.css`, `ui/Toolbar.test.tsx`
- Create: `web/src/features/studio/ui/Outliner.tsx`, `ui/Outliner.module.css`, `ui/Outliner.test.tsx`
- Create: `web/src/features/studio/ui/Inspector.tsx`, `ui/Inspector.module.css`, `ui/Inspector.test.tsx`

**Interfaces:**
- Consumes: `studioStore`, `useStudio`, `isDirty` (Task 7); `evalExpr`, units (Task 5); `PRIMITIVE_TYPES`, `PRIMITIVE_LABELS`, `MATERIAL_PRESETS` (Task 6)
- Produces:
  - `NumberField({ label, value, onCommit, length?, unit?, step?, digits? })` — shows `value` rounded; Enter/blur commits `evalExpr` result; ArrowUp/Down add ±`step` (×10 with Shift); invalid text returns to the value
  - `Toolbar({ onAdd(type), saveState, onRetry, sceneMenu })` where `saveState: SaveState` (from Task 12 — import the type from `../useAutosave`; Task 12 creates it, so in this task define the type locally in `Toolbar.tsx` as `export type SaveState = { kind: 'saved' } | { kind: 'saving' } | { kind: 'failed'; message: string }` and Task 12 imports it from here)
  - `Outliner()`, `Inspector()`

- [ ] **Step 1: Write the failing tests**

```tsx
// web/src/features/studio/ui/NumberField.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { NumberField } from './NumberField';

describe('NumberField', () => {
  it('commits a worked-out expression on Enter', async () => {
    const onCommit = vi.fn();
    render(<NumberField label="X" value={10} onCommit={onCommit} length unit="mm" />);
    const field = screen.getByRole('textbox', { name: 'X' });

    await userEvent.clear(field);
    await userEvent.type(field, '1cm+2{Enter}');

    expect(onCommit).toHaveBeenCalledWith(12);
  });

  it('goes back to the value when it cannot read what was typed', async () => {
    const onCommit = vi.fn();
    render(<NumberField label="X" value={10} onCommit={onCommit} />);
    const field = screen.getByRole('textbox', { name: 'X' });

    await userEvent.clear(field);
    await userEvent.type(field, 'abc{Enter}');

    expect(onCommit).not.toHaveBeenCalled();
    expect(field).toHaveValue('10');
  });

  it('steps with the arrow keys, ten at a time with Shift', async () => {
    const onCommit = vi.fn();
    render(<NumberField label="X" value={10} onCommit={onCommit} step={1} />);
    const field = screen.getByRole('textbox', { name: 'X' });

    await userEvent.type(field, '{ArrowUp}');
    expect(onCommit).toHaveBeenLastCalledWith(11);
    await userEvent.type(field, '{Shift>}{ArrowDown}{/Shift}');
    expect(onCommit).toHaveBeenLastCalledWith(0);
  });
});
```

```tsx
// web/src/features/studio/ui/Toolbar.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { blankScene } from '../model/defaults';
import { studioStore } from '../studioStore';
import { Toolbar } from './Toolbar';

beforeEach(() => studioStore.getState().open(blankScene('Cell')));

describe('Toolbar', () => {
  it('adds the shape whose button is pressed', async () => {
    const onAdd = vi.fn();
    render(<Toolbar onAdd={onAdd} saveState={{ kind: 'saved' }} onRetry={() => {}} sceneMenu={null} />);
    await userEvent.click(screen.getByRole('button', { name: 'Add Cylinder' }));
    expect(onAdd).toHaveBeenCalledWith('cylinder');
  });

  it('switches the tool', async () => {
    render(<Toolbar onAdd={() => {}} saveState={{ kind: 'saved' }} onRetry={() => {}} sceneMenu={null} />);
    await userEvent.click(screen.getByRole('radio', { name: 'Rotate' }));
    expect(studioStore.getState().tool).toBe('rotate');
  });

  it('undoes and redoes, and says when there is nothing to', async () => {
    render(<Toolbar onAdd={() => {}} saveState={{ kind: 'saved' }} onRetry={() => {}} sceneMenu={null} />);
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    studioStore.getState().addPrimitive('box', [0, 0, 0]);
    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(studioStore.getState().scene!.objects).toHaveLength(0);
  });

  it('says when a save failed and offers to try again', async () => {
    const onRetry = vi.fn();
    render(<Toolbar onAdd={() => {}} saveState={{ kind: 'failed', message: 'Disk full' }} onRetry={onRetry} sceneMenu={null} />);
    expect(screen.getByText(/Not saved/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalled();
  });
});
```

```tsx
// web/src/features/studio/ui/Outliner.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { blankScene } from '../model/defaults';
import { studioStore } from '../studioStore';
import { Outliner } from './Outliner';

beforeEach(() => {
  studioStore.getState().open(blankScene('Cell'));
  studioStore.getState().addPrimitive('box', [0, 0, 0]);
  studioStore.getState().addPrimitive('sphere', [0, 0, 0]);
  studioStore.getState().select([]);
});

describe('Outliner', () => {
  it('lists the objects and selects the one clicked', async () => {
    render(<Outliner />);
    await userEvent.click(screen.getByRole('button', { name: 'Sphere 1' }));
    expect(studioStore.getState().selection).toEqual([studioStore.getState().scene!.objects[1].id]);
  });

  it('narrows the list to what the search matches', async () => {
    render(<Outliner />);
    await userEvent.type(screen.getByRole('searchbox', { name: 'Find an object' }), 'sph');
    expect(screen.queryByRole('button', { name: 'Box 1' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sphere 1' })).toBeInTheDocument();
  });

  it('hides and shows an object', async () => {
    render(<Outliner />);
    await userEvent.click(screen.getByRole('button', { name: 'Hide Box 1' }));
    expect(studioStore.getState().scene!.objects[0].hidden).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Show Box 1' }));
    expect(studioStore.getState().scene!.objects[0].hidden).toBe(false);
  });
});
```

```tsx
// web/src/features/studio/ui/Inspector.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { blankScene } from '../model/defaults';
import { studioStore } from '../studioStore';
import { Inspector } from './Inspector';

beforeEach(() => {
  studioStore.getState().open(blankScene('Cell'));
  studioStore.getState().updateSettings({ displayUnit: 'mm' });
  studioStore.getState().addPrimitive('box', [0, 0, 0]);
});

const box = () => studioStore.getState().scene!.objects[0];

describe('Inspector', () => {
  it('says to pick something when nothing is selected', () => {
    studioStore.getState().select([]);
    render(<Inspector />);
    expect(screen.getByText(/Select an object/)).toBeInTheDocument();
  });

  it('moves the object by a length typed in the display unit', async () => {
    render(<Inspector />);
    const x = screen.getByRole('textbox', { name: 'Position X' });
    await userEvent.clear(x);
    await userEvent.type(x, '250{Enter}');
    expect(box().position[0]).toBeCloseTo(0.25);
  });

  it('turns the object by an angle typed in degrees', async () => {
    render(<Inspector />);
    const y = screen.getByRole('textbox', { name: 'Rotation Y' });
    await userEvent.clear(y);
    await userEvent.type(y, '90{Enter}');
    expect(box().euler[1]).toBeCloseTo(Math.PI / 2);
  });

  it('renames the object', async () => {
    render(<Inspector />);
    const name = screen.getByRole('textbox', { name: 'Name' });
    await userEvent.clear(name);
    await userEvent.type(name, 'Base plate{Enter}');
    expect(box().name).toBe('Base plate');
  });

  it('applies a material preset', async () => {
    render(<Inspector />);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Material' }), 'steel');
    expect(box().mat).toEqual({ metal: 1, rough: 0.35 });
  });

  it('says a model is a placeholder until model loading arrives', () => {
    const id = box().id;
    studioStore.getState().updateObject(id, { type: 'model', model: { key: 'k.glb', ext: '.glb' } });
    render(<Inspector />);
    expect(screen.getByText(/placeholder/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `cd /c/IT/mqtt-forge-studio/web && npx vitest run src/features/studio/ui`
Expected: FAIL — modules not found.

- [ ] **Step 3: NumberField**

```tsx
// web/src/features/studio/ui/NumberField.tsx
import { useEffect, useState, type KeyboardEvent } from 'react';
import { evalExpr } from '../units/evalExpr';
import { roundTo, type DisplayUnit } from '../units/units';
import styles from './Inspector.module.css';

type Props = {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  /** A length field accepts units after numbers ('10cm+2mm'), answered in `unit`. */
  length?: boolean;
  unit?: DisplayUnit;
  step?: number;
  digits?: number;
};

/**
 * A number box that takes arithmetic as well as numbers — '1200/2', '+50' to add to what is there,
 * '10cm' in a length field — worked out on Enter or on leaving the box, and stepped with the arrow
 * keys. Text it cannot read goes back to the value rather than becoming zero.
 */
export function NumberField({ label, value, onCommit, length = false, unit = 'm', step = 1, digits = 4 }: Props) {
  const shown = String(roundTo(value, digits));
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);

  const commit = () => {
    if (text === shown) return;
    const result = evalExpr(text, { current: value, length, unit });
    if (Number.isNaN(result)) setText(shown);
    else onCommit(result);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') commit();
    else if (event.key === 'Escape') setText(shown);
    else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const by = step * (event.shiftKey ? 10 : 1) * (event.key === 'ArrowUp' ? 1 : -1);
      onCommit(roundTo(value + by, 6));
    }
  };

  return (
    <label className={styles.number}>
      <span className={styles.numberLabel}>{label.split(' ').at(-1)}</span>
      <input
        type="text"
        inputMode="decimal"
        aria-label={label}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
    </label>
  );
}
```

- [ ] **Step 4: Toolbar**

```tsx
// web/src/features/studio/ui/Toolbar.tsx
import type { ReactNode } from 'react';
import { Segmented } from '../../../components/Segmented';
import { PRIMITIVE_LABELS, PRIMITIVE_TYPES } from '../model/defaults';
import type { PrimitiveType } from '../model/document';
import { studioStore, useStudio, type Orientation, type Tool } from '../studioStore';
import { DISPLAY_UNITS, type DisplayUnit } from '../units/units';
import styles from './Toolbar.module.css';

export type SaveState = { kind: 'saved' } | { kind: 'saving' } | { kind: 'failed'; message: string };

const TOOLS: ReadonlyArray<{ value: Tool; label: string }> = [
  { value: 'select', label: 'Select' },
  { value: 'move', label: 'Move' },
  { value: 'rotate', label: 'Rotate' },
  { value: 'scale', label: 'Scale' },
];
const ORIENTATIONS: ReadonlyArray<{ value: Orientation; label: string }> = [
  { value: 'world', label: 'World' },
  { value: 'local', label: 'Local' },
];
/** Metres. */
const MOVE_STEPS = [0.001, 0.01, 0.1, 0.5, 1];
/** Degrees. */
const ROTATE_STEPS = [1, 5, 15, 45, 90];

type Props = {
  onAdd: (type: PrimitiveType) => void;
  saveState: SaveState;
  onRetry: () => void;
  sceneMenu: ReactNode;
};

/** Along the top of the studio: the scene, the shapes, the tool and its steps, and whether it is saved. */
export function Toolbar({ onAdd, saveState, onRetry, sceneMenu }: Props) {
  const tool = useStudio((s) => s.tool);
  const orientation = useStudio((s) => s.orientation);
  const settings = useStudio((s) => s.scene?.settings);
  const canUndo = useStudio((s) => s.history.past.length > 0);
  const canRedo = useStudio((s) => s.history.future.length > 0);
  const { setTool, setOrientation, updateSettings, undo, redo } = studioStore.getState();

  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Studio tools">
      {sceneMenu}

      <div className={styles.shapes} role="group" aria-label="Add a shape">
        {PRIMITIVE_TYPES.map((type) => (
          <button key={type} type="button" className={styles.shape} aria-label={`Add ${PRIMITIVE_LABELS[type]}`} onClick={() => onAdd(type)}>
            {PRIMITIVE_LABELS[type]}
          </button>
        ))}
      </div>

      <Segmented label="Tool" name="studioTool" options={TOOLS} value={tool} onChange={setTool} />
      <Segmented label="Axes" name="studioOrientation" options={ORIENTATIONS} value={orientation} onChange={setOrientation} />

      {settings && (
        <div className={styles.steps}>
          <label className={styles.check}>
            <input type="checkbox" checked={settings.snap} onChange={(e) => updateSettings({ snap: e.target.checked })} />
            Snap
          </label>
          <label>
            <span className={styles.stepLabel}>Move step</span>
            <select value={settings.moveStep} onChange={(e) => updateSettings({ moveStep: Number(e.target.value) })}>
              {MOVE_STEPS.map((m) => (
                <option key={m} value={m}>
                  {m * 1000} mm
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className={styles.stepLabel}>Turn step</span>
            <select value={settings.rotateStep} onChange={(e) => updateSettings({ rotateStep: Number(e.target.value) })}>
              {ROTATE_STEPS.map((d) => (
                <option key={d} value={d}>
                  {d}°
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className={styles.stepLabel}>Units</span>
            <select value={settings.displayUnit} onChange={(e) => updateSettings({ displayUnit: e.target.value as DisplayUnit })}>
              {Object.entries(DISPLAY_UNITS).map(([unit, { label }]) => (
                <option key={unit} value={unit}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <div className={styles.history}>
        <button type="button" onClick={undo} disabled={!canUndo}>
          Undo
        </button>
        <button type="button" onClick={redo} disabled={!canRedo}>
          Redo
        </button>
      </div>

      <p className={styles.save} role="status" data-state={saveState.kind}>
        {saveState.kind === 'saved' && 'Saved'}
        {saveState.kind === 'saving' && 'Saving…'}
        {saveState.kind === 'failed' && (
          <>
            <span title={saveState.message}>Not saved</span>{' '}
            <button type="button" onClick={onRetry}>
              Try again
            </button>
          </>
        )}
      </p>
    </div>
  );
}
```

```css
/* web/src/features/studio/ui/Toolbar.module.css */
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px 18px;
  padding: 0 0 12px;
  border-bottom: 1px solid var(--rule);
}

.shapes { display: flex; flex-wrap: wrap; gap: 4px; }
.shape { font-size: 0.85em; }

.steps { display: flex; align-items: flex-end; gap: 10px; }
.stepLabel { display: block; font-size: 0.8em; color: var(--muted); }
.check { display: flex; align-items: center; gap: 6px; }

.history { display: flex; gap: 4px; }

.save { margin: 0 0 0 auto; color: var(--muted); }
.save[data-state='failed'] { color: var(--fault); }
```

- [ ] **Step 5: Outliner**

```tsx
// web/src/features/studio/ui/Outliner.tsx
import { useState } from 'react';
import { studioStore, useStudio } from '../studioStore';
import styles from './Outliner.module.css';

/**
 * Every object in the scene, by name. Children are indented under their parent; the link itself is
 * read-only until assemblies arrive, but a DesignBox scene's structure is still visible.
 */
export function Outliner() {
  const objects = useStudio((s) => s.scene?.objects ?? []);
  const selection = useStudio((s) => s.selection);
  const [look, setLook] = useState('');
  const { select, updateObject } = studioStore.getState();

  const needle = look.trim().toLowerCase();
  const shown = needle ? objects.filter((o) => o.name.toLowerCase().includes(needle)) : objects;
  const depth = (parentId: string | undefined, seen = new Set<string>()): number => {
    if (!parentId || seen.has(parentId)) return 0;
    seen.add(parentId);
    return 1 + depth(objects.find((o) => o.id === parentId)?.parentId, seen);
  };

  return (
    <nav className={styles.outliner} aria-label="Objects">
      <input
        type="search"
        className={styles.search}
        aria-label="Find an object"
        placeholder="Find…"
        value={look}
        onChange={(event) => setLook(event.target.value)}
      />
      {objects.length === 0 ? (
        <p className={styles.empty}>Nothing here yet. Add a shape from the toolbar.</p>
      ) : (
        <ul className={styles.list}>
          {shown.map((object) => (
            <li
              key={object.id}
              className={styles.row}
              data-selected={selection.includes(object.id)}
              data-hidden={object.hidden ?? false}
              style={{ paddingLeft: `${depth(object.parentId) * 14}px` }}
            >
              <button type="button" className={styles.name} onClick={() => select([object.id])}>
                {object.name}
              </button>
              <button
                type="button"
                className={styles.eye}
                aria-label={`${object.hidden ? 'Show' : 'Hide'} ${object.name}`}
                onClick={() => updateObject(object.id, { hidden: !object.hidden })}
              >
                {object.hidden ? 'Show' : 'Hide'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
```

```css
/* web/src/features/studio/ui/Outliner.module.css */
.outliner { display: flex; flex-direction: column; gap: 8px; min-height: 0; overflow: auto; }
.search { width: 100%; }
.empty { color: var(--muted); font-size: 0.9em; }
.list { list-style: none; margin: 0; padding: 0; }
.row { display: flex; align-items: center; gap: 4px; border-radius: 4px; }
.row[data-selected='true'] { background: var(--surface); outline: 1px solid var(--signal); }
.row[data-hidden='true'] .name { color: var(--muted); }
.name { all: unset; flex: 1; padding: 3px 6px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.eye { font-size: 0.75em; padding: 1px 6px; }
```

- [ ] **Step 6: Inspector**

```tsx
// web/src/features/studio/ui/Inspector.tsx
import { useEffect, useState } from 'react';
import type { Vec3 } from '../geometry/euler';
import { MATERIAL_PRESETS, type MaterialPreset } from '../model/defaults';
import { studioStore, useStudio } from '../studioStore';
import { degToRad, DISPLAY_UNITS, fromDisplay, radToDeg, toDisplay } from '../units/units';
import { NumberField } from './NumberField';
import styles from './Inspector.module.css';

const AXES = ['X', 'Y', 'Z'] as const;

/** The selected object's name, transform and look, each change one undo step. */
export function Inspector() {
  const object = useStudio((s) => (s.selection.length === 1 ? s.scene?.objects.find((o) => o.id === s.selection[0]) : undefined));
  const settings = useStudio((s) => s.scene?.settings);
  const [name, setName] = useState(object?.name ?? '');
  useEffect(() => setName(object?.name ?? ''), [object?.name]);

  if (!object || !settings) return <aside className={styles.inspector} aria-label="Inspector"><p className={styles.empty}>Select an object to see and change it here.</p></aside>;

  const { updateObject, setEuler, rename } = studioStore.getState();
  const unit = settings.displayUnit;
  const withAxis = (v: Vec3, axis: number, value: number): Vec3 => v.map((c, i) => (i === axis ? value : c)) as Vec3;
  const preset = (Object.keys(MATERIAL_PRESETS) as MaterialPreset[]).find(
    (key) => MATERIAL_PRESETS[key].metal === (object.mat?.metal ?? 0) && MATERIAL_PRESETS[key].rough === (object.mat?.rough ?? 0.5),
  );

  return (
    <aside className={styles.inspector} aria-label="Inspector">
      <label className={styles.field}>
        <span>Name</span>
        <input
          type="text"
          aria-label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => rename(object.id, name)}
          onKeyDown={(e) => e.key === 'Enter' && rename(object.id, name)}
        />
      </label>

      {object.type === 'model' && (
        <p className={styles.note}>
          A placeholder for the model file {object.model?.ext}. The studio keeps the file and draws it once model loading arrives.
        </p>
      )}

      <fieldset className={styles.group}>
        <legend>Position ({DISPLAY_UNITS[unit].label})</legend>
        {AXES.map((axis, i) => (
          <NumberField
            key={axis}
            label={`Position ${axis}`}
            value={toDisplay(object.position[i], unit)}
            length
            unit={unit}
            step={toDisplay(settings.moveStep, unit)}
            onCommit={(v) => updateObject(object.id, { position: withAxis(object.position, i, fromDisplay(v, unit)) })}
          />
        ))}
      </fieldset>

      <fieldset className={styles.group}>
        <legend>Rotation (°)</legend>
        {AXES.map((axis, i) => (
          <NumberField
            key={axis}
            label={`Rotation ${axis}`}
            value={radToDeg(object.euler[i])}
            step={settings.rotateStep}
            digits={2}
            onCommit={(v) => setEuler(object.id, withAxis(object.euler, i, degToRad(v)))}
          />
        ))}
      </fieldset>

      <fieldset className={styles.group}>
        <legend>Scale</legend>
        {AXES.map((axis, i) => (
          <NumberField
            key={axis}
            label={`Scale ${axis}`}
            value={object.scaling[i]}
            step={0.1}
            onCommit={(v) => v > 0 && updateObject(object.id, { scaling: withAxis(object.scaling, i, v) })}
          />
        ))}
      </fieldset>

      {object.type !== 'model' && (
        <fieldset className={styles.group}>
          <legend>Look</legend>
          <label className={styles.field}>
            <span>Colour</span>
            <input type="color" aria-label="Colour" value={object.color ?? '#888888'} onChange={(e) => updateObject(object.id, { color: e.target.value })} />
          </label>
          <label className={styles.field}>
            <span>Material</span>
            <select
              aria-label="Material"
              value={preset ?? ''}
              onChange={(e) => {
                const chosen = MATERIAL_PRESETS[e.target.value as MaterialPreset];
                updateObject(object.id, { mat: { metal: chosen.metal, rough: chosen.rough } });
              }}
            >
              {!preset && <option value="">Custom</option>}
              {(Object.keys(MATERIAL_PRESETS) as MaterialPreset[]).map((key) => (
                <option key={key} value={key}>
                  {MATERIAL_PRESETS[key].label}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.check}>
            <input type="checkbox" checked={object.transparent ?? false} onChange={(e) => updateObject(object.id, { transparent: e.target.checked })} />
            See-through
          </label>
        </fieldset>
      )}
    </aside>
  );
}
```

```css
/* web/src/features/studio/ui/Inspector.module.css */
.inspector { display: flex; flex-direction: column; gap: 12px; min-height: 0; overflow: auto; }
.empty, .note { color: var(--muted); font-size: 0.9em; margin: 0; }
.field { display: flex; flex-direction: column; gap: 4px; }
.check { display: flex; align-items: center; gap: 6px; }
.group { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; border: 1px solid var(--rule); border-radius: 6px; padding: 8px; margin: 0; }
.group > legend { padding: 0 4px; color: var(--muted); font-size: 0.85em; }
.group > .field, .group > .check { grid-column: 1 / -1; }
.number { display: flex; flex-direction: column; gap: 2px; }
.number input { width: 100%; font-family: var(--mono, 'JetBrains Mono', monospace); }
.numberLabel { font-size: 0.75em; color: var(--muted); }
```

- [ ] **Step 7: Run the tests**

Run: `cd /c/IT/mqtt-forge-studio/web && npx vitest run src/features/studio/ui`
Expected: PASS. Then `npx vitest run src/namedClasses.test.ts` — expected PASS (every class used is defined in its sheet).

- [ ] **Step 8: Commit**

```bash
cd /c/IT/mqtt-forge-studio
git add web/src/features/studio/ui
git commit -m "feat: the studio's toolbar, object list and inspector read and change the store directly, with number boxes that take arithmetic and units as designbox's did but without listening on the whole document"
```

---

### Task 12: Loading, autosave, scene menu, DesignBox import

**Files:**
- Create: `web/src/features/studio/useAutosave.ts`, `useAutosave.test.tsx`
- Create: `web/src/features/studio/useStudioScene.ts`
- Create: `web/src/features/studio/ui/SceneMenu.tsx`, `ui/SceneMenu.module.css`, `ui/SceneMenu.test.tsx`

**Interfaces:**
- Consumes: `api/studio.ts` (Task 8), `readSceneFile`, `uploadPending`, `SceneFileError` (Task 6), `blankScene` (Task 6), `studioStore`, `isDirty` (Task 7), `SaveState` (Task 11, from `ui/Toolbar`)
- Produces:
  - `SAVE_DEBOUNCE_MS = 500`; `useAutosave(): { state: SaveState; retry(): void; flush(): Promise<void> }`
  - `useStudioScene(): { phase: 'loading' | 'ready' | 'failed'; error: string | null }` — opens the newest scene, or a new blank one when there are none
  - `openScene(id: string): Promise<void>`
  - `SceneMenu({ flush }: { flush: () => Promise<void> })`

- [ ] **Step 1: Write the failing tests**

```tsx
// web/src/features/studio/useAutosave.test.tsx
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../test/server';
import { blankScene } from './model/defaults';
import { isDirty, studioStore } from './studioStore';
import { useAutosave } from './useAutosave';

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

beforeEach(() => studioStore.getState().open(blankScene('Cell')));
afterEach(() => vi.useRealTimers());

describe('useAutosave', () => {
  it('saves a change after a pause and marks it saved', async () => {
    const puts: unknown[] = [];
    server.use(http.put('/api/studio/scenes/:id', async ({ request }) => {
      puts.push(await request.json());
      return new HttpResponse(null, { status: 204 });
    }));
    const { result } = renderHook(() => useAutosave(), { wrapper });

    act(() => void studioStore.getState().addPrimitive('box', [0, 0, 0]));

    await waitFor(() => expect(puts).toHaveLength(1));
    await waitFor(() => expect(result.current.state.kind).toBe('saved'));
    expect(isDirty(studioStore.getState())).toBe(false);
  });

  it('keeps the change and says so when the save fails, and saves it on retry', async () => {
    let fail = true;
    server.use(http.put('/api/studio/scenes/:id', () =>
      fail
        ? HttpResponse.json({ status: 500, title: 'Could not save the studio', detail: 'Disk full', reason: 'studioNotSaved' }, { status: 500 })
        : new HttpResponse(null, { status: 204 })));
    const { result } = renderHook(() => useAutosave(), { wrapper });

    act(() => void studioStore.getState().addPrimitive('box', [0, 0, 0]));
    await waitFor(() => expect(result.current.state.kind).toBe('failed'));
    expect(isDirty(studioStore.getState())).toBe(true);

    fail = false;
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.state.kind).toBe('saved'));
  });

  it('flush saves straight away rather than after the pause', async () => {
    let saved = false;
    server.use(http.put('/api/studio/scenes/:id', () => {
      saved = true;
      return new HttpResponse(null, { status: 204 });
    }));
    const { result } = renderHook(() => useAutosave(), { wrapper });

    act(() => void studioStore.getState().addPrimitive('box', [0, 0, 0]));
    await act(() => result.current.flush());
    expect(saved).toBe(true);
  });
});
```

```tsx
// web/src/features/studio/ui/SceneMenu.test.tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import designbox from '../model/fixtures/designbox-v1.json';
import { blankScene } from '../model/defaults';
import { server } from '../../../test/server';
import { renderWithClient as render } from '../../../test/renderWithClient';
import { studioStore } from '../studioStore';
import { SceneMenu } from './SceneMenu';

const flush = () => Promise.resolve();
const current = blankScene('Cell A');
const other = blankScene('Cell B');

beforeEach(() => {
  studioStore.getState().open(current);
  server.use(
    http.get('/api/studio/scenes', () =>
      HttpResponse.json([
        { id: current.id, name: 'Cell A', updatedAt: current.updatedAt },
        { id: other.id, name: 'Cell B', updatedAt: other.updatedAt },
      ])),
    http.get(`/api/studio/scenes/${other.id}`, () => HttpResponse.json(other)),
  );
});

describe('SceneMenu', () => {
  it('opens another scene from the list', async () => {
    render(<SceneMenu flush={flush} />);
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Scene' }), other.id);
    await waitFor(() => expect(studioStore.getState().scene?.name).toBe('Cell B'));
  });

  it('starts a new, unsaved scene', async () => {
    render(<SceneMenu flush={flush} />);
    await userEvent.click(screen.getByRole('button', { name: 'New scene' }));
    expect(studioStore.getState().scene?.name).toBe('Untitled scene');
    expect(studioStore.getState().scene?.id).not.toBe(current.id);
  });

  it('renames the scene', async () => {
    render(<SceneMenu flush={flush} />);
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const field = screen.getByRole('textbox', { name: 'Scene name' });
    await userEvent.clear(field);
    await userEvent.type(field, 'Line 3{Enter}');
    expect(studioStore.getState().scene?.name).toBe('Line 3');
  });

  it('asks before deleting, and opens what is left after', async () => {
    let deleted = false;
    server.use(http.delete(`/api/studio/scenes/${current.id}`, () => {
      deleted = true;
      return new HttpResponse(null, { status: 204 });
    }));
    render(<SceneMenu flush={flush} />);

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(deleted).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Delete Cell A' }));

    await waitFor(() => expect(deleted).toBe(true));
  });

  it('imports a DesignBox scene, uploading its models first', async () => {
    server.use(http.post('/api/studio/models', () => HttpResponse.json({ key: 'a'.repeat(64) + '.stl' })));
    render(<SceneMenu flush={flush} />);

    const file = new File([JSON.stringify(designbox)], 'robot-cell.json', { type: 'application/json' });
    await userEvent.upload(screen.getByLabelText('Import a DesignBox scene'), file);

    await waitFor(() => expect(studioStore.getState().scene?.name).toBe('robot-cell'));
    expect(studioStore.getState().scene?.objects[2].model?.key).toBe('a'.repeat(64) + '.stl');
  });

  it('says why a file could not be imported', async () => {
    render(<SceneMenu flush={flush} />);
    const file = new File(['{"version": 9, "objects": []}'], 'future.json', { type: 'application/json' });
    await userEvent.upload(screen.getByLabelText('Import a DesignBox scene'), file);
    expect(await screen.findByText(/newer version/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `cd /c/IT/mqtt-forge-studio/web && npx vitest run src/features/studio/useAutosave.test.tsx src/features/studio/ui/SceneMenu.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Autosave**

```ts
// web/src/features/studio/useAutosave.ts
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { putScene } from '../../api/studio';
import { queryKeys } from '../../api/queryKeys';
import { isDirty, studioStore } from './studioStore';
import type { SaveState } from './ui/Toolbar';

/** A pause this long after the last change is when the scene is written. */
export const SAVE_DEBOUNCE_MS = 500;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Writes the open scene to the server a moment after it stops changing. A failed write keeps the
 * scene dirty and says so — it is never dropped — and `retry` or the next change tries again.
 * `flush` writes now, for whoever is about to put a different scene in the store.
 */
export function useAutosave(): { state: SaveState; retry: () => void; flush: () => Promise<void> } {
  const queryClient = useQueryClient();
  const [state, setState] = useState<SaveState>({ kind: 'saved' });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  const save = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (inFlight.current) await inFlight.current;

    const { scene, revision } = studioStore.getState();
    if (!scene || !isDirty(studioStore.getState())) return;

    setState({ kind: 'saving' });
    const attempt = putScene(scene)
      .then(() => {
        // Only the revision that was sent: a change made while it was on its way is still unsaved.
        if (studioStore.getState().scene?.id === scene.id) studioStore.getState().markSaved(revision);
        setState(isDirty(studioStore.getState()) ? { kind: 'saving' } : { kind: 'saved' });
        void queryClient.invalidateQueries({ queryKey: queryKeys.studioScenes });
      })
      .catch((error: unknown) => setState({ kind: 'failed', message: messageOf(error) }))
      .finally(() => {
        inFlight.current = null;
      });
    inFlight.current = attempt;
    await attempt;
  }, [queryClient]);

  useEffect(() => {
    const schedule = () => {
      if (!isDirty(studioStore.getState())) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void save(), SAVE_DEBOUNCE_MS);
    };
    schedule();
    const unsubscribe = studioStore.subscribe((now, before) => {
      if (now.revision !== before.revision || now.savedRevision !== before.savedRevision) schedule();
    });
    return () => {
      unsubscribe();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [save]);

  return { state, retry: () => void save(), flush: save };
}
```

- [ ] **Step 4: Loading the first scene**

```ts
// web/src/features/studio/useStudioScene.ts
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { getScene, listScenes } from '../../api/studio';
import { queryKeys } from '../../api/queryKeys';
import { blankScene } from './model/defaults';
import { readSceneFile } from './model/sceneFile';
import { studioStore, useStudio } from './studioStore';

export const UNTITLED = 'Untitled scene';

/** Reads a stored scene and puts it in the store. */
export async function openScene(id: string) {
  const { scene } = readSceneFile(await getScene(id), { id, name: UNTITLED });
  studioStore.getState().open(scene);
}

/**
 * Whatever the studio should be showing when it opens: the scene already in the store if the panel
 * was closed and opened again, else the most recently saved one, else a new one — saved straight
 * away, so a first visit leaves a scene behind rather than an empty list.
 */
export function useStudioScene(): { phase: 'loading' | 'ready' | 'failed'; error: string | null } {
  const scenes = useQuery({ queryKey: queryKeys.studioScenes, queryFn: listScenes });
  const open = useStudio((s) => s.scene !== null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open || !scenes.data) return;
    const newest = [...scenes.data].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (newest) openScene(newest.id).catch((e: unknown) => setError(`The scene "${newest.name}" could not be opened: ${e instanceof Error ? e.message : String(e)}`));
    else studioStore.getState().open(blankScene(UNTITLED), false);
  }, [open, scenes.data]);

  if (scenes.error) return { phase: 'failed', error: `The scene list could not be read: ${scenes.error.message}` };
  if (error) return { phase: 'failed', error };
  return { phase: open ? 'ready' : 'loading', error: null };
}
```

- [ ] **Step 5: Scene menu**

```tsx
// web/src/features/studio/ui/SceneMenu.tsx
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ChangeEvent } from 'react';
import { deleteScene, listScenes, uploadModel } from '../../../api/studio';
import { queryKeys } from '../../../api/queryKeys';
import { blankScene } from '../model/defaults';
import { newId } from '../model/ids';
import { readSceneFile, SceneFileError, uploadPending } from '../model/sceneFile';
import { studioStore, useStudio } from '../studioStore';
import { openScene, UNTITLED } from '../useStudioScene';
import styles from './SceneMenu.module.css';

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Which scene is open, and the things done to scenes as a whole. Every switch writes the current
 * scene first (`flush`), so moving away never loses the last half second of work.
 */
export function SceneMenu({ flush }: { flush: () => Promise<void> }) {
  const queryClient = useQueryClient();
  const scenes = useQuery({ queryKey: queryKeys.studioScenes, queryFn: listScenes });
  const scene = useStudio((s) => s.scene);
  const [mode, setMode] = useState<'idle' | 'renaming' | 'deleting' | 'importing'>('idle');
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  if (!scene) return null;

  const listed = scenes.data ?? [];
  const options = listed.some((s) => s.id === scene.id) ? listed : [{ id: scene.id, name: scene.name, updatedAt: scene.updatedAt }, ...listed];

  const run = async (work: () => Promise<void>) => {
    setProblem(null);
    try {
      await work();
    } catch (error) {
      setProblem(messageOf(error));
    }
  };

  const switchTo = (id: string) => run(async () => {
    await flush();
    await openScene(id);
  });

  const startNew = () => run(async () => {
    await flush();
    studioStore.getState().open(blankScene(UNTITLED), false);
  });

  const duplicate = () => run(async () => {
    await flush();
    studioStore.getState().open({ ...scene, id: newId(), name: `${scene.name} copy` }, false);
  });

  const remove = () => run(async () => {
    await deleteScene(scene.id);
    setMode('idle');
    const rest = listed.filter((s) => s.id !== scene.id);
    await queryClient.invalidateQueries({ queryKey: queryKeys.studioScenes });
    if (rest[0]) await openScene(rest[0].id);
    else studioStore.getState().open(blankScene(UNTITLED), false);
  });

  const rename = () => {
    studioStore.getState().renameScene(name);
    setMode('idle');
  };

  const importFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setMode('importing');
    void run(async () => {
      try {
        const raw: unknown = JSON.parse(await file.text());
        const read = readSceneFile(raw, { id: newId(), name: file.name.replace(/\.json$/i, '') || UNTITLED });
        const imported = await uploadPending(read.scene, read.pending, uploadModel);
        await flush();
        studioStore.getState().open(imported, false);
      } catch (error) {
        throw error instanceof SyntaxError ? new SceneFileError('This file is not JSON, so it is not a scene.') : error;
      } finally {
        setMode('idle');
      }
    });
  };

  return (
    <div className={styles.menu}>
      {mode === 'renaming' ? (
        <input
          type="text"
          aria-label="Scene name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') rename();
            if (e.key === 'Escape') setMode('idle');
          }}
          onBlur={rename}
        />
      ) : (
        <label className={styles.pick}>
          <span className={styles.label}>Scene</span>
          <select aria-label="Scene" value={scene.id} onChange={(e) => void switchTo(e.target.value)}>
            {options.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id === scene.id ? scene.name : s.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <button type="button" onClick={() => void startNew()} aria-label="New scene">
        New
      </button>
      <button type="button" onClick={() => { setName(scene.name); setMode('renaming'); }}>
        Rename
      </button>
      <button type="button" onClick={() => void duplicate()}>
        Duplicate
      </button>
      {mode === 'deleting' ? (
        <span className={styles.confirm}>
          <button type="button" className="ends" onClick={() => void remove()}>
            Delete {scene.name}
          </button>
          <button type="button" onClick={() => setMode('idle')}>
            Keep
          </button>
        </span>
      ) : (
        <button type="button" className="ends" onClick={() => setMode('deleting')}>
          Delete
        </button>
      )}
      <label className={styles.import}>
        <span>{mode === 'importing' ? 'Importing…' : 'Import DesignBox scene…'}</span>
        <input type="file" accept=".json,application/json" aria-label="Import a DesignBox scene" onChange={importFile} />
      </label>
      {problem && <p className={styles.problem} role="alert">{problem}</p>}
    </div>
  );
}
```

```css
/* web/src/features/studio/ui/SceneMenu.module.css */
.menu { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 6px; }
.pick { display: flex; flex-direction: column; }
.label { font-size: 0.8em; color: var(--muted); }
.confirm { display: inline-flex; gap: 4px; }
.import { position: relative; display: inline-flex; align-items: center; padding: 4px 10px; border: 1px dashed var(--rule); border-radius: 6px; cursor: pointer; }
.import input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.problem { flex-basis: 100%; margin: 0; color: var(--fault); }
```

Note on the button-tone sweep: "Delete" and "Delete it" wear the global `ends` class. If `buttonTone.test.tsx`'s TONES list is extended later for these words, they already comply.

- [ ] **Step 6: Run the tests**

Run: `cd /c/IT/mqtt-forge-studio/web && npx vitest run src/features/studio`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /c/IT/mqtt-forge-studio
git add web/src/features/studio
git commit -m "feat: the studio opens the newest scene or starts one, saves half a second after the last change and says when it could not, switches scenes only after writing the open one, and imports a designbox file with its models uploaded first"
```

---

### Task 13: The studio page, viewport and shortcuts

**Files:**
- Create: `web/src/features/studio/ui/Viewport.tsx`, `ui/Viewport.module.css`
- Create: `web/src/features/studio/useStudioShortcuts.ts`, `useStudioShortcuts.test.tsx`
- Create: `web/src/features/studio/StudioPage.tsx`, `StudioPage.module.css`, `StudioPage.test.tsx`

**Interfaces:**
- Consumes: everything above
- Produces: `default export StudioPage()`; `Viewport({ onReady(engine: StudioEngine | null) })`; `useStudioShortcuts(actions: { focus(): void }): (event: KeyboardEvent) => void`

- [ ] **Step 1: Write the failing tests**

```tsx
// web/src/features/studio/useStudioShortcuts.test.tsx
import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { blankScene } from './model/defaults';
import { studioStore } from './studioStore';
import { useStudioShortcuts } from './useStudioShortcuts';

function Host({ focus = () => {} }: { focus?: () => void }) {
  const onKeyDown = useStudioShortcuts({ focus });
  return (
    <div tabIndex={-1} data-testid="root" onKeyDown={onKeyDown}>
      <input aria-label="typing" />
    </div>
  );
}

beforeEach(() => studioStore.getState().open(blankScene('Cell')));

describe('studio shortcuts', () => {
  it('picks tools with W, E, R and Q', () => {
    const { getByTestId } = render(<Host />);
    fireEvent.keyDown(getByTestId('root'), { key: 'e' });
    expect(studioStore.getState().tool).toBe('rotate');
    fireEvent.keyDown(getByTestId('root'), { key: 'r' });
    expect(studioStore.getState().tool).toBe('scale');
    fireEvent.keyDown(getByTestId('root'), { key: 'q' });
    expect(studioStore.getState().tool).toBe('select');
  });

  it('deletes the selection, and undoes with Ctrl+Z', () => {
    const { getByTestId } = render(<Host />);
    studioStore.getState().addPrimitive('box', [0, 0, 0]);
    fireEvent.keyDown(getByTestId('root'), { key: 'Delete' });
    expect(studioStore.getState().scene!.objects).toHaveLength(0);
    fireEvent.keyDown(getByTestId('root'), { key: 'z', ctrlKey: true });
    expect(studioStore.getState().scene!.objects).toHaveLength(1);
  });

  it('duplicates with Ctrl+D and focuses with F', () => {
    const focus = vi.fn();
    const { getByTestId } = render(<Host focus={focus} />);
    studioStore.getState().addPrimitive('box', [0, 0, 0]);
    fireEvent.keyDown(getByTestId('root'), { key: 'd', ctrlKey: true });
    expect(studioStore.getState().scene!.objects).toHaveLength(2);
    fireEvent.keyDown(getByTestId('root'), { key: 'f' });
    expect(focus).toHaveBeenCalled();
  });

  // Typing a name must not delete the object or switch the tool.
  it('leaves keys alone while a field is being typed in', () => {
    const { getByLabelText } = render(<Host />);
    studioStore.getState().addPrimitive('box', [0, 0, 0]);
    fireEvent.keyDown(getByLabelText('typing'), { key: 'Delete' });
    fireEvent.keyDown(getByLabelText('typing'), { key: 'e' });
    expect(studioStore.getState().scene!.objects).toHaveLength(1);
    expect(studioStore.getState().tool).toBe('move');
  });
});
```

```tsx
// web/src/features/studio/StudioPage.test.tsx
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { server } from '../../test/server';
import { renderWithClient as render } from '../../test/renderWithClient';
import { blankScene } from './model/defaults';
import { studioStore } from './studioStore';
import StudioPage from './StudioPage';

beforeEach(() => studioStore.getState().close());

describe('StudioPage', () => {
  it('starts a new scene when there are none, and lays out the studio around it', async () => {
    render(<StudioPage />);

    expect(await screen.findByRole('combobox', { name: 'Scene' })).toHaveDisplayValue('Untitled scene');
    expect(screen.getByRole('toolbar', { name: 'Studio tools' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Objects' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Inspector' })).toBeInTheDocument();
  });

  it('opens the most recently saved scene', async () => {
    const older = { ...blankScene('Older'), updatedAt: '2026-01-01T00:00:00Z' };
    const newer = { ...blankScene('Newer'), updatedAt: '2026-06-01T00:00:00Z' };
    server.use(
      http.get('/api/studio/scenes', () => HttpResponse.json([older, newer].map(({ id, name, updatedAt }) => ({ id, name, updatedAt })))),
      http.get(`/api/studio/scenes/${newer.id}`, () => HttpResponse.json(newer)),
    );

    render(<StudioPage />);

    expect(await screen.findByRole('combobox', { name: 'Scene' })).toHaveDisplayValue('Newer');
  });

  // jsdom has no WebGL — the same as a browser with it switched off.
  it('says when 3D cannot be drawn, and the rest of the studio still works', async () => {
    render(<StudioPage />);
    expect(await screen.findByText(/cannot draw 3D/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Add Box' }));
    expect(screen.getByRole('button', { name: 'Box 1' })).toBeInTheDocument();
  });

  it('says when the scene list cannot be read', async () => {
    server.use(http.get('/api/studio/scenes', () => HttpResponse.json({ status: 500, title: 'Broken' }, { status: 500 })));
    render(<StudioPage />);
    expect(await screen.findByText(/scene list could not be read/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `cd /c/IT/mqtt-forge-studio/web && npx vitest run src/features/studio/useStudioShortcuts.test.tsx src/features/studio/StudioPage.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Shortcuts**

```ts
// web/src/features/studio/useStudioShortcuts.ts
import { useCallback, type KeyboardEvent } from 'react';
import { studioStore } from './studioStore';

const TYPING = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * The studio's keys, handled on its own root element rather than the window. DesignBox listened on
 * the window, which in the console would delete a part while someone typed in the publish box.
 */
export function useStudioShortcuts({ focus }: { focus: () => void }) {
  return useCallback(
    (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (TYPING.has(target.tagName) || target.isContentEditable) return;

      const s = studioStore.getState();
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      let handled = true;

      if (mod && key === 'z' && !event.shiftKey) s.undo();
      else if (mod && (key === 'y' || (key === 'z' && event.shiftKey))) s.redo();
      else if (mod && key === 'd') s.duplicate(s.selection);
      else if (mod && key === 'c') s.copy(s.selection);
      else if (mod && key === 'v') s.paste();
      else if (mod) handled = false;
      else if (key === 'q') s.setTool('select');
      else if (key === 'w') s.setTool('move');
      else if (key === 'e') s.setTool('rotate');
      else if (key === 'r') s.setTool('scale');
      else if (key === 'f') focus();
      else if (key === 'escape') s.select([]);
      else if (key === 'delete' || key === 'backspace') s.removeObjects(s.selection);
      else handled = false;

      if (handled) event.preventDefault();
    },
    [focus],
  );
}
```

- [ ] **Step 4: Viewport**

```tsx
// web/src/features/studio/ui/Viewport.tsx
import { useEffect, useRef, useState } from 'react';
import { StudioEngine, WebGLUnavailable } from '../engine/StudioEngine';
import { studioStore } from '../studioStore';
import styles from './Viewport.module.css';

/**
 * The canvas, and the engine's life: made when the viewport mounts, disposed when it unmounts —
 * which is when the panel closes. What the engine cannot do is said here, inside the panel.
 */
export function Viewport({ onReady }: { onReady: (engine: StudioEngine | null) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [lost, setLost] = useState(false);

  useEffect(() => {
    if (!canvas.current) return;
    let engine: StudioEngine | null = null;
    try {
      engine = StudioEngine.open(canvas.current, studioStore, (status) => setLost(status === 'lost'));
      onReady(engine);
    } catch (error) {
      setProblem(error instanceof WebGLUnavailable ? error.message : `The 3D view could not start: ${error instanceof Error ? error.message : String(error)}`);
      onReady(null);
    }
    return () => {
      onReady(null);
      engine?.dispose();
    };
  }, [onReady]);

  return (
    <div className={styles.viewport}>
      <canvas ref={canvas} className={styles.canvas} aria-label="3D view" />
      {problem && <p className={styles.notice} role="alert">{problem}</p>}
      {lost && !problem && <p className={styles.notice} role="status">The graphics card dropped the 3D view; it comes back on its own in a moment.</p>}
    </div>
  );
}
```

```css
/* web/src/features/studio/ui/Viewport.module.css */
.viewport { position: relative; min-width: 0; min-height: 0; border: 1px solid var(--rule); border-radius: 6px; overflow: hidden; background: #14171c; }
.canvas { display: block; width: 100%; height: 100%; outline: none; touch-action: none; }
.notice { position: absolute; inset: auto 12px 12px 12px; margin: 0; padding: 8px 10px; background: var(--paper); color: var(--ink); border: 1px solid var(--rule); border-radius: 6px; }
```

- [ ] **Step 5: The page**

```tsx
// web/src/features/studio/StudioPage.tsx
import { useCallback, useRef } from 'react';
import panel from '../../styles/panel.module.css';
import type { StudioEngine } from './engine/StudioEngine';
import type { PrimitiveType } from './model/document';
import { studioStore } from './studioStore';
import { Inspector } from './ui/Inspector';
import { Outliner } from './ui/Outliner';
import { SceneMenu } from './ui/SceneMenu';
import { Toolbar } from './ui/Toolbar';
import { Viewport } from './ui/Viewport';
import { useAutosave } from './useAutosave';
import { useStudioScene } from './useStudioScene';
import { useStudioShortcuts } from './useStudioShortcuts';
import styles from './StudioPage.module.css';

/**
 * The studio: toolbar along the top, objects on the left, the 3D view in the middle and the
 * inspector on the right. Its own chunk — Babylon comes with it, and only when the panel opens.
 */
export default function StudioPage() {
  const { phase, error } = useStudioScene();
  const save = useAutosave();
  const engine = useRef<StudioEngine | null>(null);
  const onReady = useCallback((made: StudioEngine | null) => {
    engine.current = made;
  }, []);
  const onKeyDown = useStudioShortcuts({ focus: () => engine.current?.focusSelection() });

  // Where the camera looks when there is a view; the origin when there is none to ask.
  const add = (type: PrimitiveType) => studioStore.getState().addPrimitive(type, engine.current?.viewCentre() ?? [0, 0, 0]);

  if (phase === 'failed') return <p className={panel.fault}>{error}</p>;
  if (phase === 'loading') return <p className={panel.note}>Opening the scene…</p>;

  return (
    <div className={styles.page} tabIndex={-1} onKeyDown={onKeyDown}>
      <Toolbar onAdd={add} saveState={save.state} onRetry={save.retry} sceneMenu={<SceneMenu flush={save.flush} />} />
      <div className={styles.body}>
        <Outliner />
        <Viewport onReady={onReady} />
        <Inspector />
      </div>
    </div>
  );
}
```

```css
/* web/src/features/studio/StudioPage.module.css */
.page { display: flex; flex-direction: column; gap: 12px; height: 100%; min-height: 480px; outline: none; }
.body { flex: 1; display: grid; grid-template-columns: minmax(160px, 220px) minmax(0, 1fr) minmax(220px, 280px); gap: 12px; min-height: 0; }

@media (max-width: 760px) {
  .body { grid-template-columns: 1fr; grid-template-rows: auto minmax(320px, 1fr) auto; }
}
```

- [ ] **Step 6: Run the tests**

Run: `cd /c/IT/mqtt-forge-studio/web && npx vitest run src/features/studio`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /c/IT/mqtt-forge-studio
git add web/src/features/studio
git commit -m "feat: the studio page lays out toolbar, objects, view and inspector, keeps its keys to its own element so typing elsewhere in the console is safe, and says inside the panel when the browser cannot draw 3d"
```

---

### Task 14: The 3D Studio panel in the rail

**Files:**
- Create: `web/src/features/studio/StudioPanel.tsx`, `StudioPanel.test.tsx`
- Modify: `web/src/features/brand/icons.tsx` (add `Cube` after `Nodes`)
- Modify: `web/src/features/panels.ts`
- Modify: `web/src/App.tsx:36,61,353`
- Modify: `web/src/App.test.tsx:345-355`

**Interfaces:**
- Consumes: `StudioPage` (Task 13)
- Produces: `StudioPanel({ onClose })`; `PanelId` gains `'studio'`; `Cube` icon

- [ ] **Step 1: Write the failing tests**

```tsx
// web/src/features/studio/StudioPanel.test.tsx
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const chunk = { arrives: false };

/** As FlowsPanel's test: a chunk that does not arrive, or arrives and fails while it draws. */
async function freshPanel() {
  vi.resetModules();
  vi.doMock('./StudioPage', () => {
    if (!chunk.arrives) throw new TypeError('error loading dynamically imported module: /assets/StudioPage-x1.js');
    return {
      default: function StudioPage(): never {
        throw new Error('The view lost its scene.');
      },
    };
  });
  return (await import('./StudioPanel')).StudioPanel;
}

beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe('3D Studio panel', () => {
  it('says the studio could not be loaded, and offers a reload', async () => {
    chunk.arrives = false;
    const StudioPanel = await freshPanel();
    render(<StudioPanel onClose={() => {}} />);

    expect(await screen.findByText(/could not be loaded/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload the console' })).toBeInTheDocument();
  });

  it('says what went wrong when the studio fails while drawing', async () => {
    chunk.arrives = true;
    const StudioPanel = await freshPanel();
    render(<StudioPanel onClose={() => {}} />);

    expect(await screen.findByText(/The view lost its scene/)).toBeInTheDocument();
  });

  it('is a named region with a close button', async () => {
    chunk.arrives = true;
    const StudioPanel = await freshPanel();
    render(<StudioPanel onClose={() => {}} />);

    expect(screen.getByRole('region', { name: '3D Studio panel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close 3D Studio panel' })).toBeInTheDocument();
  });
});
```

In `web/src/App.test.tsx`, change the expected rail list (around line 345) to put `'3D Studioβ'` right after `'Flowsβ'`, and add beside the Flows tests:

```tsx
  it('offers 3D Studio in the rail, marked as experimental, across the whole workspace', async () => {
    renderApp();
    const row = menu().getByRole('button', { name: '3D Studio' });
    expect(row).toHaveAttribute('title', '3D Studio (experimental)');

    await userEvent.click(row);
    expect(await screen.findByRole('region', { name: '3D Studio panel' })).toBeInTheDocument();
  });
```

(Follow the exact helper names — `renderApp`, `menu` — and the `title` wording that the Flows test at line 386–399 uses; if the Flows test checks a `data-panel` attribute for the whole-workspace shape, copy that assertion too.)

- [ ] **Step 2: Run to see them fail**

Run: `cd /c/IT/mqtt-forge-studio/web && npx vitest run src/features/studio/StudioPanel.test.tsx src/App.test.tsx`
Expected: FAIL.

- [ ] **Step 3: The panel wrapper**

```tsx
// web/src/features/studio/StudioPanel.tsx
import { lazy, Suspense } from 'react';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { PanelShell } from '../../components/PanelShell';
import panel from '../../styles/panel.module.css';

/** The import failed — told apart by type, not by each browser's own words. See FlowsPanel for the long version. */
class PageNotLoaded extends Error {
  constructor(cause: unknown) {
    super('The studio could not be loaded.', { cause });
  }
}

/**
 * The studio is its own chunk, and the heaviest in the console: it carries Babylon. This file is
 * all of it the main bundle holds, so a reader who never opens 3D Studio never downloads an engine.
 * The chunk-failure reasoning is FlowsPanel's — a stale tab, a stopped server, and a browser that
 * caches a failed import — and so is the answer: a reload.
 */
const StudioPage = lazy(() =>
  import('./StudioPage').catch((error: unknown) => {
    throw new PageNotLoaded(error);
  }),
);

export function StudioPanel({ onClose }: { onClose: () => void }) {
  return (
    <PanelShell title="3D Studio" named stretch onClose={onClose}>
      <ErrorBoundary fallback={(error) => <Stopped error={error} />}>
        <Suspense fallback={<p className={panel.note}>Loading the studio…</p>}>
          <StudioPage />
        </Suspense>
      </ErrorBoundary>
    </PanelShell>
  );
}

function Stopped({ error }: { error: Error }) {
  const cause = error instanceof PageNotLoaded && error.cause instanceof Error ? error.cause.message : undefined;

  return (
    <div>
      <p className={panel.fault}>
        {error instanceof PageNotLoaded
          ? 'The studio could not be loaded. If the console was updated after this window was opened, a reload fetches the new one; if the server has stopped, start it first.'
          : `The studio hit an error: ${error.message}`}
      </p>
      {cause && <p className={panel.note}>{cause}</p>}
      <div className={panel.actions}>
        <button type="button" onClick={() => window.location.reload()}>
          Reload the console
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Icon, panel list, App**

`web/src/features/brand/icons.tsx` — after `Nodes`:

```tsx
/** 3D Studio: a cube seen from a corner, its three visible faces. */
export const Cube = () => (
  <Glyph>
    <>
      <path d="M12 3 20 7.5v9L12 21l-8-4.5v-9L12 3Z" />
      <path d="M4 7.5 12 12l8-4.5" />
      <path d="M12 12v9" />
    </>
  </Glyph>
);
```

Update the file's opening comment counts if it counts panels ("Nine panels" → "Ten panels").

`web/src/features/panels.ts`:
- import `Cube` alongside the other icons;
- add `| 'studio'` to `PanelId` after `'flows'`;
- after the Flows entry in `PANELS`:

```ts
  // Beside Flows and for the same reason: an experiment, and a tool rather than a way of reading.
  // It is where a machine is drawn so its joints can later follow its topics.
  { id: 'studio', label: '3D Studio', group: 'Tools', icon: Cube, beta: true },
```

`web/src/App.tsx`:
- `import { StudioPanel } from './features/studio/StudioPanel';` after the FlowsPanel import;
- `studio: StudioPanel,` in `PANEL_VIEWS` after `flows`;
- in the `wide` expression add `|| openPanel === 'studio'` to the `'fill'` condition, and update the comment above it ("Four of the nine" → "Five of the ten").

- [ ] **Step 5: Run the affected tests, then the sweeps**

Run: `cd /c/IT/mqtt-forge-studio/web && npx vitest run src/features/studio/StudioPanel.test.tsx src/App.test.tsx`
Expected: PASS.

Run: `cd /c/IT/mqtt-forge-studio/web && npx vitest run src/a11ySweeps.test.tsx src/buttonTone.test.tsx src/focusReturn.test.tsx src/namedClasses.test.ts src/gallery.render.test.tsx`
Expected: PASS. These open every panel in `PANELS`, now including 3D Studio. If a sweep names a studio control, fix the control (an accessible name that matches its printed text, a class its sheet defines, focus returning to the rail row on close) — not the sweep.

- [ ] **Step 6: Commit**

```bash
cd /c/IT/mqtt-forge-studio
git add web/src
git commit -m "feat: 3d studio joins the rail under tools beside flows, marked experimental, taking the whole workspace and loading babylon only when it is opened"
```

---

### Task 15: Whole-suite check and the real thing in a browser

**Files:** none new unless a check fails.

- [ ] **Step 1: Frontend type-check, build and suite**

Run: `cd /c/IT/mqtt-forge-studio/web && npm run build && npm test`
Expected: build succeeds; all tests pass. Note the size of the `StudioPage-*.js` chunk in the build output and confirm the main `index-*.js` chunk did not grow by more than a few kB compared with `main` (Babylon must be only in the studio chunk).

- [ ] **Step 2: Backend suites, including static files now the frontend is built**

Run: `cd /c/IT/mqtt-forge-studio && dotnet test`
Expected: all pass, including `StaticFileCachingTests`.

- [ ] **Step 3: Run it**

Add a launch config in the worktree if none exists (`.claude/launch.json`) with two entries: `api` (`dotnet run --project src/MqttForge.Api -p:SkipFrontend=true`, port 5169) and `web` (`npm --prefix web run dev`, port 5173). Start both with `preview_start`, then in the browser pane:
1. Open 3D Studio from the rail. Expect a blank "Untitled scene" with the grid and lighting.
2. Add a Box and a Cylinder; move one with the gizmo; type `250` into Position X; press Ctrl+Z twice and Ctrl+Y once — check each step.
3. Reload the page; open 3D Studio — the scene is as it was.
4. Import `C:\IT\DesignBox` scene file: export one from DesignBox first if no `sahne.json` exists (open `C:\IT\DesignBox` with `npm start`, use its "save scene" button), then use "Import DesignBox scene…". Expect its objects in the outliner and models as grey placeholders.
5. Close the panel and reopen it — no console errors, scene intact (engine disposed and rebuilt).
6. `read_console_messages` with `onlyErrors: true` — expect none.

Take a screenshot of step 4 for the user. Stop both servers with `preview_stop` when done.

- [ ] **Step 4: Commit any fixes the checks needed**

```bash
cd /c/IT/mqtt-forge-studio
git add -A
git commit -m "fix: <what the whole-suite or browser check found, and why it held>"
```

(Skip if nothing changed.)

---

## Self-review notes

- Spec coverage: panel/lazy chunk (T14), engine/dispose (T9–10), store + gesture undo (T7), versioned document + v1 migration (T6), server store + content-addressed models + GC with grace (T1–4), autosave + indicator + retry (T12), scene list/new/rename/duplicate/delete/import (T12), English UI + tokens + CSS Modules (T11–13), focus-scoped shortcuts (T13), WebGL unavailable / context lost / scene unreadable / list unreadable / save failure (T4, T10, T12, T13), clean-ups (one formatter T5, one id generator T5, one mesh mapping T9, no per-frame allocations T10, no empty catch / prompt / innerHTML throughout), tests at every layer, manual check (T15).
- Deliberate deviations are listed under Global Constraints.
