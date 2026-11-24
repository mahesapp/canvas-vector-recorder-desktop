//! Opaque, local, user-space gradients emitted by the tracing engine.
use super::transform::f;

#[derive(Debug)]
pub struct Gradient {
    pub radial: bool,
    pub coords: Vec<f64>,
    pub stops: Vec<(f64, [f64; 3])>,
}

fn invalid() -> crate::AppError {
    crate::AppError::InvalidEvent("Gradasi SVG tracing tidak valid".into())
}

pub fn parse(node: roxmltree::Node<'_, '_>) -> Result<Gradient, crate::AppError> {
    let radial = match node.tag_name().name() {
        "linearGradient" => false,
        "radialGradient" => true,
        _ => return Err(invalid()),
    };
    if node.attribute("gradientUnits") != Some("userSpaceOnUse") {
        return Err(invalid());
    }
    let names: &[&str] = if radial {
        &["cx", "cy", "r"]
    } else {
        &["x1", "y1", "x2", "y2"]
    };
    let coords: Vec<f64> = names
        .iter()
        .map(|name| {
            node.attribute(*name)
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite())
                .ok_or_else(invalid)
        })
        .collect::<Result<_, _>>()?;
    if (radial && coords[2] <= 0.0)
        || (!radial && (coords[2] - coords[0]).hypot(coords[3] - coords[1]) < 1e-6)
    {
        return Err(invalid());
    }
    let mut stops = Vec::new();
    for stop in node.children().filter(|n| n.is_element()) {
        if !stop.has_tag_name("stop") {
            return Err(invalid());
        }
        let offset = stop
            .attribute("offset")
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|v| v.is_finite())
            .ok_or_else(invalid)?;
        let hex = stop.attribute("stop-color").unwrap_or("");
        if hex.len() != 7
            || !hex.starts_with('#')
            || !hex[1..].bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(invalid());
        }
        let mut rgb = [0.0; 3];
        for (i, value) in rgb.iter_mut().enumerate() {
            *value = u8::from_str_radix(&hex[1 + i * 2..3 + i * 2], 16).map_err(|_| invalid())?
                as f64
                / 255.0;
        }
        if !(0.0..=1.0).contains(&offset)
            || stops
                .last()
                .is_some_and(|(previous, _)| *previous >= offset)
        {
            return Err(invalid());
        }
        stops.push((offset, rgb));
    }
    if stops.len() < 2 || stops.len() > 32 || stops[0].0 != 0.0 || stops[stops.len() - 1].0 != 1.0 {
        return Err(invalid());
    }
    Ok(Gradient {
        radial,
        coords,
        stops,
    })
}

pub fn shading(
    document: &roxmltree::Document<'_>,
    fill: &str,
) -> Result<Option<String>, crate::AppError> {
    if !fill.starts_with("url(") {
        return Ok(None);
    }
    let id = fill
        .strip_prefix("url(#")
        .and_then(|v| v.strip_suffix(')'))
        .ok_or_else(invalid)?;
    let node = document
        .descendants()
        .find(|n| {
            matches!(n.tag_name().name(), "linearGradient" | "radialGradient")
                && n.attribute("id") == Some(id)
        })
        .ok_or_else(invalid)?;
    let g = parse(node)?;
    let rgb = |color: &[f64; 3]| color.iter().map(|v| f(*v)).collect::<Vec<_>>().join(" ");
    let functions: Vec<_> = g
        .stops
        .windows(2)
        .map(|s| {
            format!(
                "<< /FunctionType 2 /Domain [0 1] /C0 [{}] /C1 [{}] /N 1 >>",
                rgb(&s[0].1),
                rgb(&s[1].1)
            )
        })
        .collect();
    let function = if functions.len() == 1 {
        functions[0].clone()
    } else {
        format!(
            "<< /FunctionType 3 /Domain [0 1] /Functions [{}] /Bounds [{}] /Encode [{}] >>",
            functions.join(" "),
            g.stops[1..g.stops.len() - 1]
                .iter()
                .map(|s| f(s.0))
                .collect::<Vec<_>>()
                .join(" "),
            vec!["0 1"; functions.len()].join(" ")
        )
    };
    let c = &g.coords;
    let coords = if g.radial {
        vec![c[0], c[1], 0.0, c[0], c[1], c[2]]
    } else {
        c.clone()
    };
    Ok(Some(format!("<< /ShadingType {} /ColorSpace /DeviceRGB /Coords [{}] /Extend [true true] /Function {} >> shfill\n",if g.radial {3} else {2},coords.iter().map(|v|f(*v)).collect::<Vec<_>>().join(" "),function)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn linear_radial_and_multistop_shadings_are_vector_functions() {
        for (tag, attrs, kind) in [
            ("linearGradient", "x1=\"0\" y1=\"0\" x2=\"8\" y2=\"0\"", 2),
            ("radialGradient", "cx=\"4\" cy=\"4\" r=\"4\"", 3),
        ] {
            let xml = format!(
                r##"<svg><defs><{tag} id="g" gradientUnits="userSpaceOnUse" {attrs}><stop offset="0" stop-color="#ff0000"/><stop offset="0.5" stop-color="#00ff00"/><stop offset="1" stop-color="#0000ff"/></{tag}></defs></svg>"##
            );
            let doc = roxmltree::Document::parse(&xml).unwrap();
            let ps = shading(&doc, "url(#g)").unwrap().unwrap();
            assert!(ps.contains(&format!("/ShadingType {kind}")));
            assert!(ps.contains("/FunctionType 3"));
            assert!(ps.contains("/Bounds [0.5]"));
            assert!(!ps.contains("image"));
        }
    }
}
