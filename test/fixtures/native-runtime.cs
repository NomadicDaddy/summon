// A native console program standing in for bun.exe or pwsh.exe in the installer helper tests
// (test/fixtures/prerequisite-helper.ts compiles it with Add-Type). Its behaviour comes from
// "<its own path>.txt": a plain line is printed to stdout (default 1.4.3), and sleep=<ms>,
// stderr=<bytes>, pidfile=<path> and exit=<code> lines set the rest. pidfile records that it really
// ran, and with which process id. It is never packaged or distributed.
using System;
using System.IO;
using System.Threading;

public static class NativeRuntimeFixture {
	public static int Main() {
		string self = System.Reflection.Assembly.GetEntryAssembly().Location;
		string output = "1.4.3";
		int sleep = 0;
		int stderr = 0;
		int code = 0;
		string pidfile = null;
		if (File.Exists(self + ".txt")) {
			foreach (string line in File.ReadAllLines(self + ".txt")) {
				if (line.StartsWith("sleep=")) sleep = int.Parse(line.Substring(6));
				else if (line.StartsWith("stderr=")) stderr = int.Parse(line.Substring(7));
				else if (line.StartsWith("exit=")) code = int.Parse(line.Substring(5));
				else if (line.StartsWith("pidfile=")) pidfile = line.Substring(8);
				else output = line;
			}
		}
		if (pidfile != null) File.WriteAllText(pidfile, System.Diagnostics.Process.GetCurrentProcess().Id.ToString());
		string chunk = new string('x', 99);
		for (int i = 0; i < stderr / 100; i++) Console.Error.WriteLine(chunk);
		if (sleep > 0) Thread.Sleep(sleep);
		Console.WriteLine(output);
		return code;
	}
}
