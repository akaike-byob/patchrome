import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { helperFailure, parseApprovalAnswer, type HostPrompts } from "./copy-guard.ts";

const run = promisify(execFile);

// WSL interop runs Windows' powershell.exe from Linux. Scripts go in -EncodedCommand, and every string from
// patchrome goes in as base64, so a session name or file path can never become PowerShell code.
export function encodedPowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

export function powerShellString(text: string): string {
  return `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(text, "utf8").toString("base64")}')))`;
}

// Windows Hello is the prompt a script cannot answer. Without Hello set up there is no such prompt, and the
// copy is refused rather than falling back to a clickable message box.
export function approvalScript(reason: string, timeoutMs: number): string {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } | Select-Object -First 1
function Wait-WinRt($operation, [Type]$resultType, [int]$timeoutMs) {
  $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
  if (-not $task.Wait($timeoutMs)) { return $null }
  return $task.Result
}
$verifier = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
$availability = Wait-WinRt ($verifier::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability]) 10000
if ("$availability" -ne 'Available') { "unavailable Windows Hello is $availability"; return }
$result = Wait-WinRt ($verifier::RequestVerificationAsync(${powerShellString(reason)})) ([Windows.Security.Credentials.UI.UserConsentVerificationResult]) ${timeoutMs}
if ($null -eq $result) { 'timed_out' }
elseif ("$result" -eq 'Verified') { 'approved' }
elseif ("$result" -eq 'Canceled' -or "$result" -eq 'RetriesExhausted') { 'denied' }
else { "unavailable Windows Hello answered $result" }
`;
}

export function notifyScript(title: string, body: string): string {
  return `
$ErrorActionPreference = 'Stop'
$manager = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$toast = $manager::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$texts = $toast.GetElementsByTagName('text')
$null = $texts.Item(0).AppendChild($toast.CreateTextNode(${powerShellString(title)}))
$null = $texts.Item(1).AppendChild($toast.CreateTextNode(${powerShellString(body)}))
# Toasts need a registered app id; Windows PowerShell's own is present on every Windows install.
$manager::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($toast))
`;
}

function powerShell(script: string, timeoutMs: number) {
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedPowerShell(script)], { timeout: timeoutMs });
}

export const wslPrompts: HostPrompts = {
  async askApproval(reason, timeoutMs) {
    try {
      const { stdout } = await powerShell(approvalScript(reason, timeoutMs), timeoutMs + 20_000);
      return parseApprovalAnswer(stdout);
    } catch (err) {
      return { answer: "unavailable", detail: helperFailure("powershell.exe", err) };
    }
  },
  async notify(title, body) {
    await powerShell(notifyScript(title, body), 20_000);
  },
};
