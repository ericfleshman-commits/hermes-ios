"""Check the actual signed app before installing it. No inferred renewal dates."""
import argparse
from datetime import datetime, timezone
from pathlib import Path
import plistlib
import re
import subprocess


def check_expiry(profile, now, minimum_hours):
    expiry = profile.get('ExpirationDate')
    if not isinstance(expiry, datetime):
        raise ValueError('Signing profile has no expiration date')
    if expiry.tzinfo is None:
        expiry = expiry.replace(tzinfo=timezone.utc)
    hours = (expiry - now).total_seconds() / 3600
    if hours < minimum_hours:
        raise ValueError(f'Signing expires at {expiry.isoformat()}; only {hours:.1f} hours remain (need {minimum_hours})')
    return expiry, hours


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('app', type=Path)
    parser.add_argument('--minimum-hours', type=float, default=24)
    parser.add_argument('--install', metavar='DEVICE', help='Install only after all checks pass')
    args = parser.parse_args()
    if args.minimum_hours < 24:
        parser.error('minimum-hours must be at least 24')
    app = args.app.resolve()
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
    profile = plistlib.loads(subprocess.run(
        ['security', 'cms', '-D', '-i', str(app / 'embedded.mobileprovision')],
        check=True, capture_output=True).stdout)
    expiry, hours = check_expiry(profile, datetime.now(timezone.utc), args.minimum_hours)
    info = plistlib.loads((app / 'Info.plist').read_bytes())
    if info.get('CFBundleIdentifier') != 'com.ericfleshman.hermesmobile':
        raise ValueError('Unexpected bundle identifier')
    source = (Path(__file__).resolve().parents[1] / 'src/App.tsx').read_text()
    tag = re.search(r'const BUILD_TAG = "([^"]+)"', source).group(1)
    bundle = (app / 'main.jsbundle').read_bytes()
    if tag.encode() not in bundle and tag.encode('utf-16-le') not in bundle:
        raise ValueError('App bundle does not contain the current source build tag')
    print(f'Verified {tag}; signing expires {expiry.isoformat()} ({hours:.1f} hours remain)')
    if args.install:
        subprocess.run(['xcrun', 'devicectl', 'device', 'install', 'app', '--device', args.install, str(app)], check=True)


if __name__ == '__main__':
    main()
