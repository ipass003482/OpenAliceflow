using System.Collections;
using System.Globalization;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;

return await BridgeProgram.RunAsync(args);

internal static class BridgeProgram
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static async Task<int> RunAsync(string[] args)
    {
        var runtimeDir = ReadArg(args, "--runtime-dir")
            ?? Environment.GetEnvironmentVariable("OPENALICE_YUANTA_RUNTIME_DIR");
        using var host = new SparkHost(runtimeDir);
        string? line;
        while ((line = await Console.In.ReadLineAsync()) is not null)
        {
            RpcResponse response;
            try
            {
                var request = JsonSerializer.Deserialize<RpcRequest>(line, JsonOptions)
                    ?? throw new BridgeException("BAD_REQUEST", "Invalid JSON-RPC request.");
                var result = await DispatchAsync(host, request);
                response = new(request.Id, true, result, null);
                if (request.Method == "shutdown")
                {
                    await Console.Out.WriteLineAsync(JsonSerializer.Serialize(response, JsonOptions));
                    break;
                }
            }
            catch (Exception ex)
            {
                var root = ex is TargetInvocationException { InnerException: not null } tie ? tie.InnerException : ex;
                var code = root is BridgeException bridge ? bridge.Code : "SPARK_ERROR";
                response = new(ExtractId(line), false, null, new RpcError(code, root?.Message ?? "Unknown bridge error"));
            }
            await Console.Out.WriteLineAsync(JsonSerializer.Serialize(response, JsonOptions));
        }
        return 0;
    }

    private static async Task<object?> DispatchAsync(SparkHost host, RpcRequest request)
    {
        var p = request.Params;
        return request.Method switch
        {
            "initialize" => await host.InitializeAsync(
                RequiredString(p, "environment"),
                RequiredString(p, "account"),
                RequiredString(p, "password"),
                RequiredBool(p, "acceptVendorLicense")),
            "shutdown" => host.Shutdown(),
            "getPositions" => await host.GetPositionsAsync(),
            "getOrders" => await host.GetOrdersAsync(),
            "getAccount" => await host.GetAccountAsync(),
            "getQuote" => await host.GetQuoteAsync(RequiredString(p, "market"), RequiredString(p, "stockCode")),
            "searchContracts" => await host.SearchContractsAsync(RequiredString(p, "pattern")),
            "placeStockOrder" => await host.PlaceStockOrderAsync(p),
            "modifyStockOrder" => await host.ModifyStockOrderAsync(p),
            "cancelStockOrder" => await host.CancelStockOrderAsync(p),
            _ => throw new BridgeException("METHOD_NOT_FOUND", $"Unsupported bridge method: {request.Method}"),
        };
    }

    private static string? ReadArg(string[] args, string name)
    {
        var index = Array.IndexOf(args, name);
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
    }

    private static string RequiredString(JsonElement element, string name)
        => element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()!
            : throw new BridgeException("BAD_REQUEST", $"Missing {name}.");

    private static bool RequiredBool(JsonElement element, string name)
        => element.TryGetProperty(name, out var value) && value.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? value.GetBoolean()
            : throw new BridgeException("BAD_REQUEST", $"Missing {name}.");

    private static string ExtractId(string line)
    {
        try { return JsonDocument.Parse(line).RootElement.GetProperty("id").GetString() ?? "unknown"; }
        catch { return "unknown"; }
    }
}

internal sealed class SparkHost : IDisposable
{
    private readonly string? _runtimeDir;
    private readonly object _gate = new();
    private readonly Dictionary<string, Queue<TaskCompletionSource<object?>>> _waiters = new(StringComparer.OrdinalIgnoreCase);
    private Assembly? _assembly;
    private object? _api;
    private EventInfo? _responseEvent;
    private Delegate? _responseDelegate;
    private string? _account;

    public SparkHost(string? runtimeDir) => _runtimeDir = runtimeDir;

    public async Task<object> InitializeAsync(string environment, string account, string password, bool accepted)
    {
        if (!string.Equals(environment, "uat", StringComparison.OrdinalIgnoreCase))
            throw new BridgeException("PROD_DISABLED", "This Bridge only supports Yuanta SPARK UAT.");
        if (!accepted) throw new BridgeException("LICENSE_REQUIRED", "Yuanta component license consent is required.");
        if (string.IsNullOrWhiteSpace(_runtimeDir) || !Directory.Exists(_runtimeDir))
            throw new BridgeException("RUNTIME_MISSING", "Yuanta SPARK runtime is not installed. Install it from the OpenAlice Trading screen.");
        var dll = Path.Combine(_runtimeDir, "YuantaSparkAPI.dll");
        if (!File.Exists(dll)) throw new BridgeException("RUNTIME_MISSING", $"YuantaSparkAPI.dll was not found in the installed runtime.");

        AppDomain.CurrentDomain.AssemblyResolve += ResolveVendorAssembly;
        _assembly = Assembly.LoadFrom(dll);
        var apiType = RequireType("YuantaOneAPI.YuantaSparkAPITrader");
        _api = Activator.CreateInstance(apiType) ?? throw new BridgeException("RUNTIME_INVALID", "Cannot create YuantaSparkAPITrader.");
        AttachResponseEvent(apiType);
        Invoke("SetLogType", EnumValue("YuantaOneAPI.enumLogType", "COMMON"));
        Invoke("Open", EnumValue("YuantaOneAPI.enumEnvironmentMode", "UAT"));
        _account = account;
        await InvokeAndWaitAsync("Login", () => Invoke("Login", account, password), TimeSpan.FromSeconds(30));
        return new { environment = "uat", account = MaskAccount(account), ready = true };
    }

    public object Shutdown()
    {
        if (_api is not null)
        {
            try { Invoke("Close"); } catch { }
            try { Invoke("Dispose"); } catch { }
        }
        return new { closed = true };
    }

    public async Task<object?> GetPositionsAsync()
    {
        var result = await InvokeAndWaitAsync("GetStoreSummary", () => Invoke("GetStoreSummary", RequireAccount()), TimeSpan.FromSeconds(20));
        return Normalize(GetProperty(result, "StkStoreList")) ?? Array.Empty<object>();
    }

    public async Task<object?> GetOrdersAsync()
    {
        var result = await InvokeAndWaitAsync("GetOrderTradeReport", () => Invoke("GetOrderTradeReport", false, RequireAccount()), TimeSpan.FromSeconds(20));
        return FlattenOrderRows(result);
    }

    public async Task<object> GetAccountAsync()
    {
        var positionsResult = await InvokeAndWaitAsync("GetStoreSummary", () => Invoke("GetStoreSummary", RequireAccount()), TimeSpan.FromSeconds(20));
        object? bankResult = null;
        try { bankResult = await InvokeAndWaitAsync("GetBankBalance", () => Invoke("GetBankBalance", RequireAccount()), TimeSpan.FromSeconds(20)); } catch { }
        var positionRows = Enumerate(GetProperty(positionsResult, "StkStoreList")).ToArray();
        var marketValue = positionRows.Sum(row => Number(row, "MarketValue", "MktValue", "NowAmount"));
        var unrealized = positionRows.Sum(row => Number(row, "UnrealizedProfitLoss", "UnrealizedGainLoss", "ProfitLoss"));
        var cash = Enumerate(GetProperty(bankResult, "BankBalanceList")).Sum(row => Number(row, "Balance", "BankBalance", "AvailableAmount"));
        return new { baseCurrency = "TWD", netLiquidation = cash + marketValue, totalCashValue = cash, unrealizedPnL = unrealized, buyingPower = cash };
    }

    public async Task<object?> GetQuoteAsync(string market, string stockCode)
    {
        var item = Create("YuantaOneAPI.StkInformation");
        Set(item, "MarketType", EnumValue("YuantaOneAPI.enumMarketType", NormalizeMarketEnum(market)));
        Set(item, "StkCode", stockCode);
        var list = CreateGenericList(item.GetType(), item);
        var result = await InvokeAndWaitAsync("GetStockInformation", () => Invoke("GetStockInformation", RequireAccount(), list), TimeSpan.FromSeconds(20));
        return Normalize(Enumerate(GetProperty(result, "StkInformationList", "StockInformationList", "StkInfoList")).FirstOrDefault() ?? result);
    }

    public async Task<object?> SearchContractsAsync(string pattern)
    {
        if (!pattern.All(char.IsDigit)) return Array.Empty<object>();
        var rows = new List<object?>();
        foreach (var market in new[] { "TWSE", "TPEx" })
        {
            try { rows.Add(await GetQuoteAsync(market, pattern)); } catch { }
        }
        return rows.Where(row => row is not null).ToArray();
    }

    public async Task<object?> PlaceStockOrderAsync(JsonElement p)
    {
        var order = BuildStockOrder(p, "00");
        var list = CreateGenericList(order.GetType(), order);
        return Normalize(await InvokeAndWaitAsync("SendStockOrder", () => Invoke("SendStockOrder", RequireAccount(), list), TimeSpan.FromSeconds(20)));
    }

    public async Task<object?> ModifyStockOrderAsync(JsonElement p)
    {
        var orderNo = Required(p, "orderNo");
        var prior = await FindOrderAsync(orderNo);
        var tradeKind = p.TryGetProperty("price", out var price) && price.ValueKind != JsonValueKind.Null ? "07" : "03";
        var payload = CopyOrderIntoJson(prior, p);
        var order = BuildStockOrder(payload, tradeKind, orderNo);
        var list = CreateGenericList(order.GetType(), order);
        return Normalize(await InvokeAndWaitAsync("SendStockOrder", () => Invoke("SendStockOrder", RequireAccount(), list), TimeSpan.FromSeconds(20)));
    }

    public async Task<object?> CancelStockOrderAsync(JsonElement p)
    {
        var orderNo = Required(p, "orderNo");
        var prior = await FindOrderAsync(orderNo);
        var payload = CopyOrderIntoJson(prior, p);
        var order = BuildStockOrder(payload, "04", orderNo);
        var list = CreateGenericList(order.GetType(), order);
        return Normalize(await InvokeAndWaitAsync("SendStockOrder", () => Invoke("SendStockOrder", RequireAccount(), list), TimeSpan.FromSeconds(20)));
    }

    private object BuildStockOrder(JsonElement p, string tradeKind, string orderNo = "")
    {
        var order = Create("YuantaOneAPI.StockOrder");
        Set(order, "Identity", Random.Shared.Next(1, int.MaxValue));
        Set(order, "Account", RequireAccount());
        Set(order, "OrderNo", orderNo);
        Set(order, "TradeDate", DateTime.UtcNow.AddHours(8).ToString("yyyy/MM/dd", CultureInfo.InvariantCulture));
        var oddLot = p.TryGetProperty("oddLot", out var odd) && odd.ValueKind == JsonValueKind.True;
        Set(order, "APCode", Convert.ToInt16(oddLot ? 4 : 0));
        Set(order, "TradeKind", Convert.ToInt16(tradeKind));
        Set(order, "OrderType", "0");
        Set(order, "StkCode", Required(p, "stockCode"));
        Set(order, "BuySell", Required(p, "side").StartsWith("B", StringComparison.OrdinalIgnoreCase) ? "B" : "S");
        var marketOrder = string.Equals(Required(p, "orderType"), "MKT", StringComparison.OrdinalIgnoreCase);
        Set(order, "PriceFlag", marketOrder ? "M" : " ");
        Set(order, "Price", marketOrder ? 0d : double.Parse(Required(p, "price"), CultureInfo.InvariantCulture));
        Set(order, "OrderQty", long.Parse(Required(p, "quantity"), CultureInfo.InvariantCulture));
        var tif = p.TryGetProperty("timeInForce", out var tifValue) ? tifValue.GetString() : "ROD";
        Set(order, "Time_in_force", tif == "IOC" ? "3" : tif == "FOK" ? "4" : "0");
        return order;
    }

    private async Task<object> FindOrderAsync(string orderNo)
    {
        var rows = (IEnumerable<object?>)(await GetOrdersAsync() ?? Array.Empty<object?>());
        return rows.FirstOrDefault(row => string.Equals(Convert.ToString(GetProperty(row, "OrderNo")), orderNo, StringComparison.Ordinal))
            ?? throw new BridgeException("ORDER_NOT_FOUND", $"Yuanta order {orderNo} was not found.");
    }

    private static JsonElement CopyOrderIntoJson(object prior, JsonElement changes)
    {
        var payload = new Dictionary<string, object?>
        {
            ["stockCode"] = Convert.ToString(GetProperty(prior, "StockCode", "StkCode")),
            ["side"] = Convert.ToString(GetProperty(prior, "BuySell"))?.StartsWith("B") == true ? "BUY" : "SELL",
            ["orderType"] = Convert.ToString(GetProperty(prior, "PriceFlag"))?.Trim() == "M" ? "MKT" : "LMT",
            ["price"] = Convert.ToString(GetProperty(prior, "Price"), CultureInfo.InvariantCulture) ?? "0",
            ["quantity"] = Convert.ToString(GetProperty(prior, "OrderQty"), CultureInfo.InvariantCulture) ?? "0",
            ["timeInForce"] = "ROD",
            ["oddLot"] = Convert.ToInt64(GetProperty(prior, "APCode") ?? 0) is 2 or 4,
        };
        foreach (var property in changes.EnumerateObject()) payload[property.Name] = JsonSerializer.Deserialize<object>(property.Value.GetRawText());
        return JsonSerializer.SerializeToElement(payload);
    }

    private async Task<object?> InvokeAndWaitAsync(string responseName, Action invoke, TimeSpan timeout)
    {
        var source = new TaskCompletionSource<object?>(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (_gate)
        {
            if (!_waiters.TryGetValue(responseName, out var queue)) _waiters[responseName] = queue = new();
            queue.Enqueue(source);
        }
        try
        {
            invoke();
            return await source.Task.WaitAsync(timeout);
        }
        catch
        {
            lock (_gate)
            {
                if (_waiters.TryGetValue(responseName, out var queue) && queue.Count > 0 && ReferenceEquals(queue.Peek(), source)) queue.Dequeue();
            }
            throw;
        }
    }

    private void OnResponse(int intMark, uint dwIndex, string strIndex, object objHandle, object objValue)
    {
        TaskCompletionSource<object?>? source = null;
        lock (_gate)
        {
            if (_waiters.TryGetValue(strIndex, out var queue) && queue.Count > 0) source = queue.Dequeue();
        }
        source?.TrySetResult(objValue);
    }

    private void AttachResponseEvent(Type apiType)
    {
        _responseEvent = apiType.GetEvent("OnResponse") ?? throw new BridgeException("RUNTIME_INVALID", "SPARK OnResponse event is missing.");
        var handler = GetType().GetMethod(nameof(OnResponse), BindingFlags.Instance | BindingFlags.NonPublic)!;
        _responseDelegate = Delegate.CreateDelegate(_responseEvent.EventHandlerType!, this, handler);
        _responseEvent.AddEventHandler(_api, _responseDelegate);
    }

    private Assembly? ResolveVendorAssembly(object? sender, ResolveEventArgs e)
    {
        if (_runtimeDir is null) return null;
        var name = new AssemblyName(e.Name).Name;
        var path = Path.Combine(_runtimeDir, $"{name}.dll");
        return File.Exists(path) ? Assembly.LoadFrom(path) : null;
    }

    private object? Invoke(string name, params object?[] args)
    {
        var methods = _api?.GetType().GetMethods().Where(method => method.Name == name && method.GetParameters().Length == args.Length).ToArray()
            ?? throw new BridgeException("NOT_INITIALIZED", "SPARK is not initialized.");
        foreach (var method in methods)
        {
            try { return method.Invoke(_api, args); } catch (ArgumentException) { }
        }
        throw new BridgeException("RUNTIME_INVALID", $"No compatible SPARK method overload: {name}/{args.Length}.");
    }

    private Type RequireType(string name) => _assembly?.GetType(name) ?? throw new BridgeException("RUNTIME_INVALID", $"SPARK type is missing: {name}.");
    private object Create(string typeName) => Activator.CreateInstance(RequireType(typeName)) ?? throw new BridgeException("RUNTIME_INVALID", $"Cannot create {typeName}.");
    private object EnumValue(string typeName, string name) => Enum.Parse(RequireType(typeName), name, true);
    private string RequireAccount() => _account ?? throw new BridgeException("NOT_INITIALIZED", "SPARK account is not initialized.");

    private static object CreateGenericList(Type itemType, object item)
    {
        var list = (IList)Activator.CreateInstance(typeof(List<>).MakeGenericType(itemType))!;
        list.Add(item);
        return list;
    }

    private static void Set(object target, string name, object? value)
    {
        var property = target.GetType().GetProperty(name, BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase)
            ?? throw new BridgeException("RUNTIME_INVALID", $"SPARK field is missing: {target.GetType().Name}.{name}.");
        var destination = Nullable.GetUnderlyingType(property.PropertyType) ?? property.PropertyType;
        property.SetValue(target, value is null || destination.IsInstanceOfType(value) ? value : Convert.ChangeType(value, destination, CultureInfo.InvariantCulture));
    }

    private static object? GetProperty(object? target, params string[] names)
    {
        if (target is null) return null;
        if (target is IDictionary dictionary)
        {
            foreach (var name in names)
                foreach (DictionaryEntry entry in dictionary)
                    if (string.Equals(Convert.ToString(entry.Key), name, StringComparison.OrdinalIgnoreCase)) return entry.Value;
        }
        foreach (var name in names)
        {
            var property = target.GetType().GetProperty(name, BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
            if (property is not null) return property.GetValue(target);
        }
        return null;
    }

    private static IEnumerable<object> Enumerate(object? value)
    {
        if (value is IEnumerable sequence and not string)
            foreach (var row in sequence) if (row is not null) yield return row;
    }

    private static object?[] FlattenOrderRows(object? result)
    {
        if (result is null) return Array.Empty<object?>();
        var rows = new List<object?>();
        foreach (var property in result.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (!property.Name.Contains("Order", StringComparison.OrdinalIgnoreCase) && !property.Name.Contains("Report", StringComparison.OrdinalIgnoreCase)) continue;
            rows.AddRange(Enumerate(property.GetValue(result)));
        }
        return rows.Select(Normalize).ToArray();
    }

    private static decimal Number(object target, params string[] names)
        => decimal.TryParse(Convert.ToString(GetProperty(target, names), CultureInfo.InvariantCulture), NumberStyles.Any, CultureInfo.InvariantCulture, out var value) ? value : 0;

    private static object? Normalize(object? value, int depth = 0)
    {
        if (value is null || depth > 6) return null;
        var type = value.GetType();
        if (type.IsEnum) return value.ToString();
        if (value is string or bool or byte or short or int or long or float or double or decimal or DateTime) return value;
        if (value is IEnumerable sequence)
        {
            var list = new List<object?>();
            foreach (var row in sequence) list.Add(Normalize(row, depth + 1));
            return list;
        }
        var output = new Dictionary<string, object?>();
        foreach (var property in type.GetProperties(BindingFlags.Public | BindingFlags.Instance).Where(p => p.CanRead && p.GetIndexParameters().Length == 0))
        {
            try { output[property.Name] = Normalize(property.GetValue(value), depth + 1); } catch { }
        }
        return output;
    }

    private static string NormalizeMarketEnum(string market) => market.Contains("TP", StringComparison.OrdinalIgnoreCase) ? "TPEx" : "TWSE";
    private static string Required(JsonElement element, string name) => element.TryGetProperty(name, out var value) ? value.ToString() : throw new BridgeException("BAD_REQUEST", $"Missing {name}.");
    private static string MaskAccount(string account) => account.Length <= 5 ? "***" : $"{account[..2]}***{account[^3..]}";

    public void Dispose()
    {
        Shutdown();
        if (_responseEvent is not null && _responseDelegate is not null && _api is not null) _responseEvent.RemoveEventHandler(_api, _responseDelegate);
        AppDomain.CurrentDomain.AssemblyResolve -= ResolveVendorAssembly;
    }
}

internal sealed record RpcRequest(string Id, string Method, JsonElement Params);
internal sealed record RpcResponse(string Id, bool Ok, object? Result, RpcError? Error);
internal sealed record RpcError(string Code, string Message);
internal sealed class BridgeException(string code, string message) : Exception(message) { public string Code { get; } = code; }
