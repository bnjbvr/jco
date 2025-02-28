//! This file has been auto-generated, please do not modify manually
//! To regenerate this file re-run `cargo xtask generate tests` from the project root

use std::fs;
use tempdir::TempDir;
use xshell::{cmd, Shell};

#[test]
fn preview2_tcp_sockopts() -> anyhow::Result<()> {
    let sh = Shell::new()?;
    let file_name = "preview2_tcp_sockopts";
    let tempdir = TempDir::new("{file_name}")?;
    let wasi_file = test_utils::compile(&sh, &tempdir, &file_name)?;
    let _ = fs::remove_dir_all("./tests/rundir/preview2_tcp_sockopts");
    cmd!(sh, "./src/jco.js run  --jco-dir ./tests/rundir/preview2_tcp_sockopts --jco-import ./tests/virtualenvs/base.js {wasi_file} hello this '' 'is an argument' 'with 🚩 emoji'").run()?;
    Ok(())
}
