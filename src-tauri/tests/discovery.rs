//! 真机扫描：这台机器上到底有哪些 agent 能被发现。
//!
//! 不是断言测试，跑完看输出（不同机器结果本来就不一样）。
//!   cargo test --test discovery -- --ignored --nocapture

use sincearc_lib::acp::discover;

#[tokio::test]
#[ignore]
async fn 真机扫描_打印结果() {
    let t0 = std::time::Instant::now();
    let out = discover::scan().await;
    println!(
        "\n扫描耗时 {:?}，候选 {} 个",
        t0.elapsed(),
        out.candidates.len()
    );
    for w in &out.warnings {
        println!("  警告: {w}");
    }
    for c in &out.candidates {
        let hits: Vec<&discover::Found> = out
            .found
            .iter()
            .filter(|f| f.candidate_id == c.id)
            .collect();
        if hits.is_empty() {
            println!("  ✗ {:<16} {} · 未安装", c.name, c.mode);
        }
        for h in hits {
            println!("  ✓ {:<16} {} · {:<12} {}", c.name, c.mode, h.host, h.path);
            println!("        启动: {} {}", c.acp_program, c.acp_args.join(" "));
        }
    }
    println!();
}
