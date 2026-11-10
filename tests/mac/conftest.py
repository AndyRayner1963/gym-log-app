"""Shared helpers: each test gets its own temp folder, a local bare git repository acting as GitHub,
a clone of it acting as ~/gym-log-data, and a Gym Logging folder holding the sample setup workbook."""
import json
import os
import shutil
import subprocess
import sys

import pytest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FIXTURES = os.path.join(ROOT, "fixtures")
SCRIPT = os.path.join(ROOT, "mac", "gymsync.py")
SAMPLE = os.path.join(FIXTURES, "Gym Setup (sample).xlsx")


def git(cwd, *args, check=True):
    env = dict(os.environ, GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1")
    p = subprocess.run(["git", "-c", "user.name=Test", "-c", "user.email=t@localhost"] + list(args), cwd=cwd,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True, env=env)
    if check and p.returncode:
        raise RuntimeError("git %s failed: %s" % (args, p.stdout))
    return p.stdout.strip()


class Env(object):
    def __init__(self, tmp, seed_setup):
        self.tmp = str(tmp)
        self.origin = os.path.join(self.tmp, "origin.git")
        self.data = os.path.join(self.tmp, "gym-log-data")
        self.folder = os.path.join(self.tmp, "Gym Logging")
        self.home = os.path.join(self.tmp, "home")
        os.makedirs(self.home)
        os.makedirs(self.folder)
        os.makedirs(os.path.join(self.folder, "Status"))
        subprocess.check_call(["git", "init", "--bare", "-q", "-b", "main", self.origin])
        seed = os.path.join(self.tmp, "seed")
        subprocess.check_call(["git", "clone", "-q", self.origin, seed], stderr=subprocess.DEVNULL)
        shutil.copytree(os.path.join(FIXTURES, "sessions"), os.path.join(seed, "sessions"))
        if seed_setup:
            shutil.copy(os.path.join(FIXTURES, "setup.json"), seed)
        open(os.path.join(seed, "README.md"), "w").write("test store\n")
        git(seed, "add", "-A")
        git(seed, "commit", "-q", "-m", "seed")
        git(seed, "push", "-q", "origin", "HEAD:main")
        subprocess.check_call(["git", "clone", "-q", self.origin, self.data], stderr=subprocess.DEVNULL)
        shutil.copy(SAMPLE, os.path.join(self.folder, "Gym Setup.xlsx"))

    @property
    def setup_xlsx(self):
        return os.path.join(self.folder, "Gym Setup.xlsx")

    @property
    def history(self):
        return os.path.join(self.folder, "Gym History.xlsx")

    def run(self, *args, extra_env=None):
        env = dict(os.environ, GYMSYNC_FOLDER=self.folder, GYMSYNC_DATA_REPO=self.data, HOME=self.home,
                   GIT_CONFIG_GLOBAL=os.path.join(self.home, "nogitconfig"), GIT_CONFIG_NOSYSTEM="1")
        env.pop("GYMSYNC_GIT", None)
        env.update(extra_env or {})
        p = subprocess.run([sys.executable, SCRIPT] + list(args), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           universal_newlines=True, env=env, cwd=self.tmp)
        p.lines = p.stdout.splitlines()
        p.summary = p.lines[-1] if p.lines else ""
        return p

    def origin_head(self):
        return git(self.origin, "rev-parse", "main")

    def origin_file(self, path):
        out = subprocess.run(["git", "show", "main:" + path], cwd=self.origin, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, universal_newlines=True)
        return out.stdout if out.returncode == 0 else None

    def push_change(self, fn, message="change"):
        """Make a change from a second clone (the phone / the other Mac) and push it to the store."""
        other = os.path.join(self.tmp, "other-%d" % len(os.listdir(self.tmp)))
        subprocess.check_call(["git", "clone", "-q", self.origin, other], stderr=subprocess.DEVNULL)
        fn(other)
        git(other, "add", "-A")
        git(other, "commit", "-q", "-m", message)
        git(other, "push", "-q", "origin", "HEAD:main")

    def session_path(self, repo, prefix):
        d = os.path.join(repo, "sessions", "2026")
        return os.path.join(d, [f for f in os.listdir(d) if f.startswith(prefix)][0])


@pytest.fixture
def env(tmp_path):
    return Env(tmp_path, seed_setup=False)


@pytest.fixture
def env_seeded(tmp_path):
    return Env(tmp_path, seed_setup=True)
