using System.Diagnostics;
using System.Windows.Forms;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        try
        {
            var repositoryRoot = LocateRepository();
            var launcher = Path.Combine(repositoryRoot, "scripts", "start-operator-engine.cmd");
            if (!File.Exists(launcher)) throw new FileNotFoundException("The Operator Engine launcher is missing.", launcher);

            var start = new ProcessStartInfo
            {
                FileName = "cmd.exe",
                WorkingDirectory = repositoryRoot,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
            };
            start.ArgumentList.Add("/d");
            start.ArgumentList.Add("/c");
            start.ArgumentList.Add(launcher);
            if (Process.Start(start) is null) throw new InvalidOperationException("Windows did not start Operator Engine.");
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "Operator Engine", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private static string LocateRepository()
    {
        var configured = Environment.GetEnvironmentVariable("OPERATOR_ENGINE_REPOSITORY_ROOT");
        var configFile = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Operator Engine",
            "repository.txt");
        if (string.IsNullOrWhiteSpace(configured) && File.Exists(configFile)) configured = File.ReadAllText(configFile).Trim();

        var bundled = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", ".."));
        foreach (var candidate in new[] { configured, bundled })
        {
            if (!string.IsNullOrWhiteSpace(candidate) && File.Exists(Path.Combine(candidate, "scripts", "start-operator-engine.cmd")))
                return Path.GetFullPath(candidate);
        }
        throw new DirectoryNotFoundException($"Operator Engine source was not found. Expected its path in {configFile}.");
    }
}
