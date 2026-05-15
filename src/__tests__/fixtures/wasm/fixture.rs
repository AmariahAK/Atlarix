use std::io;

pub struct Config {
    pub debug: bool,
}

pub fn run(cfg: &Config) -> io::Result<()> {
    Ok(())
}

mod inner {
    pub fn helper() {}
}
