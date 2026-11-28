// The iOS app's privacy manifests (wiki features/phone-apps § Publishing): App Store Connect
// refuses an upload whose code calls one of Apple's "required reason" APIs without declaring
// why, per bundle. So each bundle that compiles such a call (the app; the Share Extension,
// which compiles Shared/TavyaShared.swift) ships a PrivacyInfo.xcprivacy in its Resources, and
// the reasons cover what its sources call. Also: no tracking, and no background modes the app
// does not use (App Review 2.5.4).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const IOS = path.resolve('mobile/ios/App');
const project = fs.readFileSync(path.join(IOS, 'App.xcodeproj/project.pbxproj'), 'utf8');
const read = (file: string) => fs.readFileSync(path.join(IOS, file), 'utf8');

/** Apple's categories, the calls in our Swift that fall under them, and the reasons that fit our use. */
const CATEGORIES: Array<{ category: string; calls: RegExp; reasons: string[] }> = [
  { category: 'NSPrivacyAccessedAPICategoryUserDefaults', calls: /\bUserDefaults\b/, reasons: ['1C8F.1', 'CA92.1'] },
  { category: 'NSPrivacyAccessedAPICategoryFileTimestamp', calls: /attributesOfItem|creationDate|contentModificationDate|modificationDate/, reasons: ['C617.1'] },
  { category: 'NSPrivacyAccessedAPICategoryDiskSpace', calls: /volumeAvailableCapacity|systemFreeSize|attributesOfFileSystem/, reasons: ['E174.1', '85F4.1'] },
  { category: 'NSPrivacyAccessedAPICategorySystemBootTime', calls: /systemUptime|mach_absolute_time/, reasons: ['35F9.1'] },
];

/** The Swift files a target compiles (its Sources phase in the project). */
function targetSources(target: string): string[] {
  const block = new RegExp(`/\\* ${target} \\*/ = \\{\\s*isa = PBXNativeTarget;[\\s\\S]*?buildPhases = \\(([\\s\\S]*?)\\);`).exec(project)![1]!;
  const phase = /(\w+) \/\* Sources \*\//.exec(block)![1]!;
  const files = new RegExp(`${phase} /\\* Sources \\*/ = \\{[\\s\\S]*?files = \\(([\\s\\S]*?)\\);`).exec(project)![1]!;
  return [...files.matchAll(/\/\* (\S+\.swift) in Sources \*\//g)].map((match) => match[1]!);
}
function inResources(target: string): boolean {
  const block = new RegExp(`/\\* ${target} \\*/ = \\{\\s*isa = PBXNativeTarget;[\\s\\S]*?buildPhases = \\(([\\s\\S]*?)\\);`).exec(project)![1]!;
  const phase = /(\w+) \/\* Resources \*\//.exec(block)![1]!;
  return new RegExp(`${phase} /\\* Resources \\*/ = \\{[\\s\\S]*?files = \\(([\\s\\S]*?PrivacyInfo\\.xcprivacy in Resources[\\s\\S]*?)\\);`).test(project);
}
const swiftFile = (name: string) => ['App', 'Shared', 'ShareExtension'].map((dir) => path.join(dir, name)).find((file) => fs.existsSync(path.join(IOS, file)))!;
const declared = (manifest: string, category: string) =>
  [...(new RegExp(`<string>${category}</string>\\s*<key>NSPrivacyAccessedAPITypeReasons</key>\\s*<array>([\\s\\S]*?)</array>`).exec(manifest)?.[1] ?? '')
    .matchAll(/<string>([^<]+)<\/string>/g)].map((match) => match[1]!);

describe('iOS privacy manifests', () => {
  for (const [target, manifest] of [['App', 'App/PrivacyInfo.xcprivacy'], ['ShareExtension', 'ShareExtension/PrivacyInfo.xcprivacy']] as const) {
    it(`${target} declares why it calls each required-reason API, and is bundled`, () => {
      expect(inResources(target)).toBe(true);
      const text = read(manifest);
      expect(text).toMatch(/<key>NSPrivacyTracking<\/key>\s*<false\/>/);
      const sources = targetSources(target).map((name) => read(swiftFile(name))).join('\n');
      expect(sources.length).toBeGreaterThan(0);
      for (const { category, calls, reasons } of CATEGORIES) {
        if (!calls.test(sources)) continue;
        const given = declared(text, category);
        expect(given.length, `${target} calls ${category} APIs`).toBeGreaterThan(0);
        for (const reason of given) expect(reasons, `${category} reason ${reason}`).toContain(reason);
      }
    });
  }

  it('the app asks for no background mode, and says what the microphone, speech recognition and camera are for', () => {
    const info = read('App/Info.plist');
    expect(info).not.toContain('<key>UIBackgroundModes</key>');
    expect(info).toMatch(/<key>NSMicrophoneUsageDescription<\/key>\s*<string>tavya listens only while you dictate/);
    expect(info).toMatch(/<key>NSSpeechRecognitionUsageDescription<\/key>\s*<string>Apple’s speech recognition/);
    // A web file input offers Take Photo or Video on iOS; without this string choosing it kills the app.
    expect(info).toMatch(/<key>NSCameraUsageDescription<\/key>\s*<string>tavya uses the camera only when you take a photo or video/);
  });
});
